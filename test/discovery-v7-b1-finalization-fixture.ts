import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { pathToFileURL } from 'node:url';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { ProductEngine } from '../src/product/engine.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { readRunnerFinalizationAt } from '../src/discovery/discovery-finalization-runner.js';
import { returnDiscoveryResearch } from '../src/discovery/discovery-research-return.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { DOSSIER_MATERIAL_CONTRACT } from '../src/discovery/dossier-material.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { readRunnerDossierAssessmentAt } from '../src/discovery/dossier-assessment-runner.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS } from '../src/discovery/research-model.js';
import { prepareDiscoveryFinalSubject } from '../src/discovery/discovery-final.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { completed, money, paid } from './discovery-v7-dossier-seed.js';
import { finalCandidate, type FinalOutcome } from './discovery-v7-final-paid-seed.js';

export const B1_BRIEF = '  Build a ledger with an exact paid conclusion.\nRetain constraints and alternatives — α.  ';
/** One genuine generation after the accepted brief, then the ordinary runner buys D6.
 * The common lazy seed is copied by completed; no synthetic run, assessment or admission is installed here. */
export async function dossierWorld(t: TestContext, route: 'owner' | 'model' | 'partial' = 'owner', partialVerdict: 'supported' | 'return' = 'return') {
  const f = route === 'partial'
    ? await paid(t, (snapshot: Ref) => ({ action: 'no_variants', reasons: [{ code: 'bounded_search',
      message: 'No bounded variant', grounds: [snapshot] }], searchLimits: ['Saved sweep'], unknowns: ['Demand unknown'] }), true, B1_BRIEF)
    : await completed(t, route, B1_BRIEF);
  let store = f.store;
  const engine = () => new ProductEngine(store);
  const role = f.environment.value.reviewer;
  configureReaderPilot(store, f.engine.environments, 'p', { experimental: true, active: true, stopAfter: 'L2',
    reader: { actor: 'dossier-reader', model: role.model, effort: role.effort, command: role.command, speed: 'inherited' },
    agentCommand: role.command, maxRequestChars: 12_000_000, maxReadChars: 128000, maxReplyChars: 100000,
    maxCalls: 100, maxReportedTokens: 100000,
    physicalLimits: { maxRequestChars: 12_000_000, maxReplyChars: 100000, basis: 'Full local dossier and final delivery' } }, 0);
  let root: Ref;
  if ('input' in f) root = reference(produceSelectedDossier(store, 'p', f.input).record);
  else {
    const none = store.list('discovery-variant-none')[0]!;
    const handoff = await publishVariantHandoff(store, 'p', { draft: reference(store.get(f.draft.id)!),
      result: reference(none), decision: null, scope: null });
    root = reference((await producePartialDossier(store, 'p', reference(handoff.record))).record);
  }
  const dossier = await prepareDossierAssessmentSubject(store, 'p', root), bases = [{ record: dossier.manifest.ref }];
  const dossierReply = { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: dossier.subject,
    verdict: route === 'partial' ? partialVerdict : 'supported', reasons: ['Exact paid D6 for ordinary finalization'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(key => [key, { judgement: 'adequate', reason: key, bases }])),
    inventory: { materials: dossier.materials.map(row => row.address), unknowns: dossier.unknowns.map(row => row.unknown.claim),
      contradictions: dossier.contradictions.map(row => ({ id: row.contradiction.id,
        sides: row.sides.map(side => side.address), grounds: row.grounds.map(record => record.ref) })) },
    return: route === 'partial' && partialVerdict === 'return' ? { targets: [{ partialReason: 0 }], reason: 'Resolve the saved partial reason', bases } : null };
  f.reply(dossierReply);
  return { ...f, get store() { return store; }, get engine() { return engine(); }, get discovery() { return engine().discovery; },
    dossier, dossierReply, data: { calibration: { draft: reference(f.calibration.draft), question: reference(f.calibration.question) } },
    reopen() { store.close(); store = f.open(); return store; } };
}
export async function finalizationWorld(t: TestContext, route: 'owner' | 'model' | 'partial' = 'owner', partialVerdict: 'supported' | 'return' = 'return') {
  const f = await dossierWorld(t, route, partialVerdict);
  // One physical call belongs to D6. B1 cannot spend a separate allowance on D7 here.
  const runner = await new Researcher(f.store, f.discovery, f.engine.environments)
    .run('p', f.v.draft.id, 1, undefined, { producerPolicy: { discovery: 7 } });
  const proven = await readRunnerDossierAssessmentAt(f.store, 'p', reference(runner));
  assert.equal(proven.result.verdict, route === 'partial' ? partialVerdict : 'supported');
  const d6 = proven.result.assessment, packet = await prepareDiscoveryFinalSubject(f.store, 'p', d6);
  return { ...f, get store() { return f.store; }, get engine() { return f.engine; }, get discovery() { return f.discovery; }, d6, packet };
}
export type FinalizationWorld = Awaited<ReturnType<typeof finalizationWorld>>;

/** This fixture serves complete packets; a truncated packet must fail the real producer's delivered-material checks. */
export async function finalizationAdapter(f: Awaited<ReturnType<typeof dossierWorld>>, outcome: FinalOutcome, verdict: 'supported' | 'return' = 'supported') {
  f.reply({ action: 'answer', question: 'reader', value: { type: 'impossible', code: 'source_unavailable',
    evidence: [], text: 'Measure the independent final reviewer' }, citations: [] });
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Measure the B1 role', {}, undefined,
      { store: f.store, draftId: f.data.calibration.draft.id, questionId: f.data.calibration.question.id, purpose: 'assessor' });
  f.reply({ b1Outcome: outcome });
  const path = join(f.root, 'adapter.mjs'), script = readFileSync(path, 'utf8');
  assert.ok(script.includes('const research='));
  const output = 'console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,';
  assert.ok(script.includes(output));
  const candidateModule = pathToFileURL(join(process.cwd(), 'dist/test/discovery-v7-final-paid-seed.js')).href;
  writeFileSync(path, `import {finalCandidate} from ${JSON.stringify(candidateModule)};\n` + script.replace('const research=', 'let research=').replace(output,
    `if(r.subject.dossierPacket||r.subject.dossierMaterialContract===${JSON.stringify(DOSSIER_MATERIAL_CONTRACT)})research=${JSON.stringify(f.dossierReply)};
if(r.subject.contract==='discovery-final-envelope/v1'){if(!r.subject.request?.packet)throw new Error('B1 fixture requires the delivered full final packet');research=finalCandidate(r.subject.request.packet,settings.reply?.bundle?.verdict?.outcome??settings.reply?.b1Outcome,undefined,'discovery-final/v9');}
if(r.subject.contract==='discovery-final-assessment-envelope/v1'){const subject=r.subject.finalContinuation.subject,bases=[{candidate:'/verdict'}];research={contract:'discovery-final-assessment-result/v1',subject,verdict:${JSON.stringify(verdict)},reasons:['Independent exact final review'],bases,return:${verdict === 'supported' ? 'null' : "{targets:bases,reason:'Revise the final decision on its exact grounds',bases}"},classes:[]};}\n${output}`));
}


// Saved cuts of the genuine runner path. Only values and files are shared; every consumer gets its own Store/runtime.
type Calibration = { draft: Ref; question: Ref };
type ReturnData = { packet: FinalizationWorld['packet']; d6: Ref; calibration: Calibration;
  original: Ref; returned: Ref; priorFinalization: Ref; run: Ref };
type Snapshot<D extends { calibration: Calibration }> = { root: string; data: D };
type ReturnSnapshot = Snapshot<ReturnData>;
const cleanups: (() => void)[] = [];
process.once('exit', () => { for (const cleanup of cleanups.reverse()) cleanup(); });
const lifetime = { after: (cleanup: () => void) => cleanups.push(cleanup), diagnostic: () => {} } as unknown as TestContext;
let returnedSeed: Promise<ReturnSnapshot> | undefined, regeneratedSeed: Promise<ReturnSnapshot> | undefined, assessedSeed: Promise<ReturnSnapshot> | undefined;
function snapshot<D extends { calibration: Calibration }>(f: { root: string; path: string }, data: D): Snapshot<D> {
  const root = mkdtempSync(join(tmpdir(), 'omg-b1-cut-')), database = new Set([f.path, `${f.path}-wal`, `${f.path}-shm`]);
  cpSync(f.root, root, { recursive: true, filter: source => !database.has(source) });
  const db = new DatabaseSync(f.path);
  try { db.prepare('VACUUM INTO ?').run(join(root, 'state.sqlite')); } finally { db.close(); }
  chmodSync(join(root, 'state.sqlite'), 0o400);
  writeFileSync(join(root, 'adapter.mjs'), readFileSync(join(root, 'adapter.mjs'), 'utf8').replaceAll(f.root, root));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, data: structuredClone(data) };
}
async function plant<D extends { calibration: Calibration }>(t: TestContext, seed: Snapshot<D>) {
  const root = mkdtempSync(join(tmpdir(), 'omg-b1-return-copy-')), path = join(root, 'state.sqlite');
  cpSync(seed.root, root, { recursive: true }); chmodSync(path, 0o600);
  writeFileSync(join(root, 'adapter.mjs'), readFileSync(join(root, 'adapter.mjs'), 'utf8').replaceAll(seed.root, root));
  const handles: Store[] = [], open = () => { const db = new Store(path); handles.push(db); return db; };
  let store = open();
  t.after(() => { for (const db of handles) db.close(); rmSync(root, { recursive: true, force: true }); });
  const engine = new ProductEngine(store), old = engine.environments.get('p'), { projectId: _project, ...kept } = old.value;
  const command = { executable: process.execPath, args: [join(root, 'adapter.mjs')] };
  const environment = engine.environments.configure('p', { ...kept, workspace: root,
    implementer: { ...kept.implementer, command }, reviewer: { ...kept.reviewer, command }, fullCheck: command }, old.revision);
  const previous = store.get<import('../src/discovery/reader-pilot.js').ReaderPilot>('reader-pilot:p')!;
  const { projectId: _profileProject, ...settings } = previous.value;
  configureReaderPilot(store, engine.environments, 'p', { ...settings, reader: { ...settings.reader, command }, agentCommand: command }, previous.revision);
  const data = structuredClone(seed.data);
  // A copy has a new command, so measure that same role instead of borrowing the saved runtime's forecast.
  for (const role of [environment.value.implementer, environment.value.reviewer])
    await researchCall(role, environment.value, 'Measure the B1 continuation role', {}, undefined,
      { store, draftId: data.calibration.draft.id, questionId: data.calibration.question.id, purpose: 'assessor' });
  return { ...data, root, path, environment, get store() { return store; }, get engine() { return new ProductEngine(store); },
    get discovery() { return new ProductEngine(store).discovery; }, open,
    reopen() { store.close(); store = open(); return store; },
    reply(value: unknown) { writeFileSync(join(root, 'reply.json'), JSON.stringify({ tokens: 10, reply: value })); },
    wires: (): unknown[] => readFileSync(join(root, 'wire.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
async function buildReturned(): Promise<ReturnSnapshot> {
  const f = await finalizationWorld(lifetime); await finalizationAdapter(f, 'go');
  const first = await new Researcher(f.store, f.discovery, f.engine.environments).run('p', f.packet.subject.basis.draft.id,
    8, undefined, { producerPolicy: { discovery: 7 } });
  const original = await readRunnerFinalizationAt(f.store, 'p', reference(first));
  assert.equal(original.status, 'needs_owner'); assert.equal(original.outcome, 'go');
  const material = f.packet.dossier.materials.find(row => (row.value as { axis?: string }).axis === 'market'
    && (row.value as { planQuestions?: { planQuestionId: string }[] }).planQuestions?.some(q => q.planQuestionId === 'q-market'))!;
  assert.ok(material);
  f.reply({ verdict: 'supported', reasons: ['Exact market evidence requires a different final conclusion'] });
  const returned = await returnDiscoveryResearch(f.store, { project: 'p', scope: f.packet.dossier.route.scope!.ref,
    plan: f.packet.subject.basis.plan, question: 'q-market', axis: 'market', grounds: [material.address], destination: 'D7',
    final: reference(original.final!.paid), reason: 'Revise the final conclusion', requiredResult: 'A revised negative conclusion on this evidence' });
  assert.equal(returned.destination, 'D7');
  f.reply(finalCandidate(f.packet, 'no_go', undefined, 'discovery-final/v9'));
  return snapshot(f, { packet: f.packet, d6: f.d6, calibration: f.data.calibration, original: reference(original.final!.paid),
    returned: reference(returned.record), priorFinalization: first.value.finalization!, run: reference(first) });
}
export async function returnedFinalWorld(t: TestContext) {
  returnedSeed ??= buildReturned();
  return plant(t, await returnedSeed);
}
async function buildRegenerated(): Promise<ReturnSnapshot> {
  const f = await returnedFinalWorld(lifetime), before = new Set(f.store.list('model-call').map(row => row.id));
  const driven = await new EarlyStageDriver(f.engine, undefined, { discovery: 7 }).run({ project: 'p',
    draftId: f.packet.subject.basis.draft.id, maxTurns: 8, maxCalls: 1 });
  assert.ok(driven.stageResult?.research, JSON.stringify(driven.reason));
  assert.equal(f.store.list('model-call').filter(row => !before.has(row.id)).length, 1);
  assert.equal(driven.stageResult.finalization?.status, 'assessing'); assert.equal(driven.stageResult.finalization.outcome, 'no_go');
  const summary = driven.stageResult.finalSummary!;
  assert.equal(summary.acceptance.state, 'unassessed'); assert.equal(summary.outcome, 'no_go');
  assert.deepEqual(summary.basis, { kind: 'paid', record: driven.stageResult.finalization.final });
  assert.equal(summary.projection, null); assert.equal(summary.constitution, null); assert.equal(summary.permitsNextStage, false);
  return snapshot(f, { packet: f.packet, d6: f.d6, calibration: f.calibration, original: f.original,
    returned: f.returned, priorFinalization: f.priorFinalization, run: driven.stageResult.research });
}
export async function regeneratedFinalWorld(t: TestContext) {
  regeneratedSeed ??= buildRegenerated();
  return plant(t, await regeneratedSeed);
}

async function buildAssessed(): Promise<ReturnSnapshot> {
  const f = await regeneratedFinalWorld(lifetime), before = new Set(f.store.list('model-call').map(row => row.id));
  const driven = await new EarlyStageDriver(f.engine, undefined, { discovery: 7 }).run({ project: 'p',
    draftId: f.packet.subject.basis.draft.id, maxTurns: 8, maxCalls: 1 });
  assert.equal(driven.end, 'needs_owner', JSON.stringify(driven.reason)); assert.ok(driven.stageResult?.research);
  assert.equal(driven.stageResult.finalization?.outcome, 'no_go');
  const summary = driven.stageResult.finalSummary!;
  assert.equal(summary.acceptance.state, 'awaiting_decision'); assert.equal(summary.outcome, 'no_go');
  assert.deepEqual(summary.basis, { kind: 'assessment', record: driven.stageResult.finalization.assessment });
  assert.equal(summary.projection, null); assert.equal(summary.constitution, null); assert.equal(summary.permitsNextStage, false);
  assert.equal(f.store.list('model-call').filter(row => !before.has(row.id)).length, 1);
  return snapshot(f, { packet: f.packet, d6: f.d6, calibration: f.calibration, original: f.original,
    returned: f.returned, priorFinalization: f.priorFinalization, run: driven.stageResult.research });
}
export async function assessedReturnedWorld(t: TestContext) {
  assessedSeed ??= buildAssessed();
  return plant(t, await assessedSeed);
}

// The owner-selected finalization which the ordinary Driver leaves waiting for the owner, and the bypass finalizations which the ordinary
// Researcher accepts by machine admission. Each is produced once per process by the genuine path and shared as a saved cut, like the seeds above.
type WaitingData = { packet: FinalizationWorld['packet']; d6: Ref; calibration: Calibration; driven: Awaited<ReturnType<EarlyStageDriver['run']>> };
let waitingSeed: Promise<Snapshot<WaitingData>> | undefined;
async function buildWaiting(): Promise<Snapshot<WaitingData>> {
  const f = await finalizationWorld(lifetime); await finalizationAdapter(f, 'go');
  const start = money(f.store).calls.length;
  const driven = await new EarlyStageDriver(f.engine, undefined, { discovery: 7 }).run({ project: 'p',
    draftId: f.packet.subject.basis.draft.id, maxTurns: 8, maxCalls: 8 });
  assert.equal(driven.end, 'needs_owner', JSON.stringify(driven.reason));
  assert.ok(driven.stageResult?.research);
  assert.ok(money(f.store).calls.length > start);
  return snapshot(f, { packet: f.packet, d6: f.d6, calibration: f.data.calibration, driven });
}
export async function waitingOwnerWorld(t: TestContext) {
  waitingSeed ??= buildWaiting();
  return plant(t, await waitingSeed);
}

type FinalizedData = { packet: FinalizationWorld['packet']; d6: Ref; calibration: Calibration; value: Awaited<ReturnType<Researcher['run']>> };
const finalizedSeeds = new Map<FinalOutcome, Promise<Snapshot<FinalizedData>>>();
async function buildFinalized(outcome: FinalOutcome): Promise<Snapshot<FinalizedData>> {
  const f = await finalizationWorld(lifetime, 'model'); await finalizationAdapter(f, outcome);
  const value = await new Researcher(f.store, f.discovery, f.engine.environments)
    .run('p', f.packet.subject.basis.draft.id, 8, undefined, { producerPolicy: { discovery: 7 } });
  return snapshot(f, { packet: f.packet, d6: f.d6, calibration: f.data.calibration, value });
}
export async function bypassFinalizedWorld(t: TestContext, outcome: FinalOutcome) {
  if (!finalizedSeeds.has(outcome)) finalizedSeeds.set(outcome, buildFinalized(outcome));
  return plant(t, await finalizedSeeds.get(outcome)!);
}
