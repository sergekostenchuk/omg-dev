import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashJson, type Json } from '../src/canonical.js';
import { Store, type Write } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, STAGES, type Ref, type StageArtifact } from '../src/pipeline/contracts.js';
import type { Graph } from '../src/graph/model.js';
import { projectGraph } from '../src/graph/project.js';
import type { EarlyStageOutcome } from '../src/product/early-stage-driver.js';
import { git } from '../src/runtime/environment.js';
import { writeOmInput } from '../src/om/input.js';
import { inputDecisionWrite, writeAddressing } from '../src/om/addressing.js';
import { writeHorizon } from '../src/om/horizon.js';
import { fillObligations, prepareFrame, type FrameScope, type FrameRequest } from '../src/om/frame-obligations.js';
import type { LayerProposal } from '../src/om/frame-proposals.js';
import { gateCandidate, writeCandidate } from '../src/om/frame-candidate.js';
import { settleCandidate } from '../src/om/frame-accept.js';
import { advanceRun, startRun } from '../src/om/run.js';
import type { OmResult } from '../src/om/refusal.js';
import { UPSTREAM_STAGES } from '../src/discovery/requirements.js';
import type { QuestionPacketRecord } from '../src/om/question-packet.js';
import type { OmDispatch } from '../src/om/dispatch.js';
import type { RoutesRecord } from '../src/om/routes.js';
import { runIntegrityCheck } from '../src/om/integrity.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { publishSample } = await import(new URL('../../scripts/golden-sample.mjs', import.meta.url).href);
const take = <T>(r: OmResult<T>): T => { if (!r.ok) throw new Error(JSON.stringify(r.refusal)); return r.value; };
const recipePath = join(root, 'test/golden-sample-recipe.json');
const recipe = JSON.parse(readFileSync(recipePath, 'utf8')) as { project: string; desired: Graph; fields: Record<string, Json> };
const project = recipe.project, desired = recipe.desired, workspace = join(root, 'workspace');
mkdirSync(workspace);
// runtime/environment intentionally strips GIT_*; reset dates in our private executable wrapper instead.
const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), bin = join(root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'git'), `#!${process.execPath}\nimport{spawnSync}from'node:child_process';const r=spawnSync(${JSON.stringify(actualGit)},['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_DATE:'2026-10-19T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-19T00:00:00Z'}});if(r.error)throw r.error;process.exit(r.status??1);\n`, { mode: 0o700 });
process.env['PATH'] = `${bin}:${process.env['PATH']}`;
writeFileSync(join(workspace, 'README.md'), 'A local numeric transformation. produce(n)=n+1, consume(n)=2*produce(n).\n');
writeFileSync(join(workspace, 'check.mjs'), `import assert from 'node:assert/strict';import{existsSync}from'node:fs';const mode=process.argv[2];
if(mode==='produce'||mode==='all'){const{produce}=await import('./produce.mjs');assert.equal(produce(1),2);}
if(mode==='consume'||mode==='all'&&existsSync('consume.mjs')){const{consume}=await import('./consume.mjs');assert.equal(consume(1),4);}
if(mode==='missing'){const{produce}=await import('./produce.mjs');assert.throws(()=>produce(undefined),/input_missing/);}`);
git(workspace, ['init', '-b', 'main']); git(workspace, ['add', '.']);
git(workspace, ['-c', 'user.name=Golden Sample', '-c', 'user.email=golden@example.invalid', 'commit', '-m', 'recipe']);
const database = join(root, 'state.sqlite'), store = new Store(database), engine = new ProductEngine(store);
const replyPath = join(root, 'om-reply.json');
try {
  engine.execute({ type: 'create-project', project, title: project });
  engine.discovery.evidence.document(project, 'values', JSON.stringify(recipe.fields), 'application/json', 0);
  const command = { executable: process.execPath, args: ['--import', join(root, 'test/golden-sample-bootstrap.mjs'), join(root, 'test/golden-sample-adapter.mjs'), recipePath, replyPath] };
  engine.environments.configure(project, { workspace,
    implementer: { actor: 'sample-author', model: 'local-recipe', effort: 'high', command },
    reviewer: { actor: 'sample-assessor', model: 'local-recipe', effort: 'high', command },
    fullCheck: { executable: process.execPath, args: ['check.mjs', 'all'] }, timeoutMs: 10_000, requestCapacityChars: 300_000 }, 0);
  const { dispatch } = engine.execute({ type: 'configure-om-dispatch', project, protocol: 'codex-stdio' }) as OmDispatch;
  for (let i = 0; i < 150 && store.get<StageArtifact>(`stage:${project}:features`)?.value.status !== 'accepted'; i++) {
    const result = await engine.execute({ type: 'early-stage-run', project, maxTurns: 1, maxCalls: 2,
      instruction: { title: project, id: 'instruction', text: 'Build a local numeric transformation with validation.', media: 'text/plain', brief: { kind: 'text-range', start: 0, end: 53 } } }) as EarlyStageOutcome;
    console.log(JSON.stringify({ early: i, end: result.end, stage: result.stage, reason: result.reason }));
    assert.ok(['stage_paused', 'om_ready'].includes(result.end), JSON.stringify(result));
  }
  assert.equal(store.get<StageArtifact>(`stage:${project}:features`)?.value.status, 'accepted');
  const stages = Object.fromEntries(UPSTREAM_STAGES.map(stage => [stage, reference(store.get(`stage:${project}:${stage}`)!)])) as Record<typeof UPSTREAM_STAGES[number], Ref>;
  const first = take(writeOmInput(store, { project, expected: 0, stages })), graph = reference(store.get(`graph:${project}`)!);
  const decisions = first.value.gaps.filter(g => !['inventory_missing', 'question_unaddressed'].includes(g.code)).map(g => {
    const field = g.code === 'contract_node_unbound' ? 'nodes' : g.code === 'acceptance_kind_missing' ? 'checkKind' : 'state';
    const value = field === 'nodes' ? [`${project}-produce-block`, `${project}-consume-block`] : field === 'checkKind' ? 'test'
      : { writer: `${project}-produce-block`, authority: `${project}-user`, rollback: `${project}-produce-block` };
    return { pending: structuredClone(inputDecisionWrite({ project, input: reference(first), graph, layers: [], decision: { target: g.target, field, value } })) as Write };
  });
  const input = decisions.length ? take(writeAddressing(store, { project, input: reference(first), graph, decisions })) : first;
  const horizon = take(writeHorizon(store, { project, input: reference(input), graph, refinement: null, available: {},
    choice: { choiceVersion: 'golden-v1', features: [{ outcome: `${project}-result` }], excluded: [] } }));
  const frame: FrameRequest = { project, level: 2, graph, horizon: reference(horizon.gate), layer: null, frame: null, upper: null };
  const prepared = take(prepareFrame(store, frame)), projected = projectGraph(desired, 2);
  const mapped = take(fillObligations(prepared.upper as Graph, prepared.scope as FrameScope,
    { graph: desired, reference: { ...prepared.request.graph, hash: hashJson(desired) }, frame: null }, prepared.upperRef, 2));
  const nodes = projected.nodes.filter(n => n.kind === 'operation'), ids = new Set(nodes.map(n => n.id));
  const proposal: LayerProposal = { base: { graph, frame: null }, level: 2, source: 'decision', status: 'proposed', nodes,
    fills: mapped.fills.filter(f => ids.has(f.node)).map(f => ({ obligation: f.obligation, node: f.node, ...(f.port ? { port: f.port } : {}) })),
    localConnectors: projected.connectors.map(c => ({ ...c, bindings: c.bindings.filter(b => b.level === 2) })).filter(c => c.bindings.length),
    artifacts: projected.artifacts, contracts: projected.contracts, joins: projected.joins, tests: projected.tests,
    edges: projected.edges ?? [], journeys: projected.journeys ?? [], packets: projected.packets ?? [], transfers: projected.transfers ?? [], anchors: projected.anchors,
    removes: [], replaces: [], redefines: [] };
  const proposed = store.write({ id: `om-proposal:${project}:recipe`, kind: 'layer-proposal', expected: 0, value: proposal });
  const candidate = take(writeCandidate(store, { frame, proposals: [reference(proposed)] }));
  assert.equal(candidate.state, 'candidate'); if (candidate.state !== 'candidate') throw new Error('candidate missing');
  const gate = take(gateCandidate(store, { project, candidate: reference(candidate.record) }));
  assert.equal(gate.passed, true);
  take(settleCandidate(store, { project, level: 2, candidate: reference(candidate.record), outcome: { gate: 'G3', candidate: gate.candidate, graphHash: gate.graphHash, passed: gate.passed, codes: gate.findings.map(f => f.code) } }));
  take(startRun(store, { project }));
  let complete = false;
  for (let i = 0; i < 200 && !complete; i++) {
    const result = take(await advanceRun(store, { project, dispatch }));
    const state = result.record.value.state;
    console.log(JSON.stringify({ om: i, performed: result.performed?.action, state: state.phase }));
    if (result.performed?.action === 'cycle') for (const ref of result.products) {
      const cycle = store.get<{ diagnostic: Ref | null }>(ref.id, ref.revision)!;
      assert.equal(cycle.value.diagnostic, null, JSON.stringify(cycle.value.diagnostic && store.get(cycle.value.diagnostic.id, cycle.value.diagnostic.revision)));
    }
    if (state.phase === 'step' && state.step.action === 'cycle') {
      const saved = (state.step.request as unknown as { packet: Ref }).packet;
      const packet = store.get<QuestionPacketRecord>(saved.id, saved.revision)!;
      const routes = store.get<RoutesRecord>(packet.value.request.routes.id, packet.value.request.routes.revision)!.value;
      const batch = routes.batches.find(b => b.id === packet.value.request.batch)!;
      assert.equal(batch.task, 'node-expansion'); assert.equal(batch.level, 3);
      const payload = packet.value.packet as unknown as { brief?: { labels: { domain: string; label: string; value: string }[] }; expansion: { assigned: string[]; obligations: { id: string; kind: string; upper: { port?: string } }[] } };
      const work = structuredClone(desired.nodes.find(n => n.kind === 'work' && n.parent === batch.node)!); assert.ok(work);
      writeFileSync(replyPath, JSON.stringify({ action: 'answer', bindings: [], proposal: { nodes: [work], tests: desired.tests.filter(t => work.tests.includes(t.id)),
        fills: payload.expansion.obligations.filter(o => payload.expansion.assigned.includes(o.id)).map(o => ({ obligation: payload.brief?.labels.find(l => l.domain === 'slot' && l.value === o.id)?.label ?? o.id, node: work.id,
          ...(o.kind === 'connection-end' ? { port: o.upper.port!, codeRef: work.code[0]! } : {}) })),
        localConnectors: [], artifacts: [], contracts: [], joins: [], edges: [], journeys: [], packets: [], transfers: [], anchors: [], removes: [], replaces: [], redefines: [] } }));
    }
    complete = state.phase === 'complete';
    assert.ok(complete || state.phase === 'step' || state.phase === 'ready', JSON.stringify(state));
  }
  assert.ok(complete, 'OM must complete');
  const plan = (store.get<StageArtifact>(`stage:${project}:compilation`)!.value.content as unknown as { plan: Ref }).plan;
  await engine.execute({ type: 'execute-plan', project, plan, retry: false, maxContextChars: 300_000, maxCorrections: 0 });
  const landmarks = Object.fromEntries(STAGES.map(stage => { const record = store.get<StageArtifact>(`stage:${project}:${stage}`)!; assert.equal(record?.value.status, 'accepted', stage); return [stage, reference(record)]; }));
  const integrity = take(runIntegrityCheck(store, { project })); assert.deepEqual(integrity.value.findings, []);
  const frozen = JSON.parse(readFileSync(join(root, 'frozen.json'), 'utf8'));
  const metadata = { ...frozen, project, landmarks, databaseId: store.databaseId, proofCache: 'empty', externalRoot: root };
  store.proofCacheClear(); store.close();
  const published = publishSample(database, process.argv[2]!, metadata);
  console.log(JSON.stringify({ sample: published.sqliteFileSha256, bytes: published.sqliteBytes, accepted: STAGES }));
} finally { store.close(); }
