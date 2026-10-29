import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import { storeReads, type Store, type Revision } from '../src/storage/store.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun, PaidDiscoveryAttemptsAssessment } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, readV7AssessmentReplay, savedV7ProgressApplication, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { historicalProofCounters, historicalReadsReachGenuine, historicalTrace, pendingSnapshotView } from '../src/history/proofs.js';
import { captureView, pendingOverlay } from '../src/storage/store-view.js';
import { integrityId } from '../src/om/integrity.js';
import { ProductEngine } from '../src/product/engine.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

/**
 * OMG-V7-PROOF-SPEED (L11/L22, owner rule 08.10): a saved assessment's history is proved once and reused by the common
 * proof cache under its hash tree; a later step of the same research run is not a reason to derive it again, hot or from a
 * cold Store. Tampered bytes are found by om-fsck when a Discovery entry starts, as at om-start/om-continue.
 */

/** One plan question attempted, assessed and applied through the real producers, on one research run. */
async function applied(t: TestContext, apply = true) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-proof-speed-entry-' }), project = 'p';
  await f.engine.execute({ type: 'create-project', project, title: 'Entry proof speed' });
  let runId: string | null = null;
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const run = runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({ id: `research-run:${rand()}`, kind: 'research-run',
      expected: 0, value: { projectId: project, draftId: draft.id, environment: reference(f.environment), turns: 0, limit: 100, requestChars: 0,
        owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runId = run.id; const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run), draft: reference(draft),
      question: reference(question), role: f.environment.value.implementer, dispatch: f.environment.value, profile: null,
      cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input), invoke = () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt,
      context, undefined, { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent),
        requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  const entry = await produce(g), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: 'q-industry', entries: [entry] });
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: { verdict: 'supported', reasons: ['Paid sweep'], return: null,
    novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: [], newContent: [], duplicates: [],
      noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
    methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } } }));
  const assessment = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
  if (apply) applyDiscoveryAssessment(f.store, project, reference(assessment));
  return { ...g, project, run: runId!, assessment: reference(assessment) };
}
/** A later step of the run: its next revision, the way every entry of a pass moves it. */
function step(store: Store, id: string): Revision<ResearchRun> {
  const head = store.get<ResearchRun>(id)!;
  return store.write<ResearchRun>({ id, kind: 'research-run', expected: head.revision, value: { ...head.value, turns: head.value.turns + 1 } });
}
const read = (store: Store, f: Awaited<ReturnType<typeof applied>>) => canonical({
  assessment: readDiscoveryAssessment(store, f.project, f.assessment) as Revision<PaidDiscoveryAttemptsAssessment>,
  replay: readV7AssessmentReplay(store, f.project, f.assessment) } as never);

/** Every assessment-read/v1 sequence a saved record holds — the frozen reads its evaluation replays positionally. */
function capturedReads(store: Store): { id: string; revision: number | null }[] {
  const found: { id: string; revision: number | null }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value === null || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (row.contract === 'assessment-read/v1' && Array.isArray(row.reads)) found.push(...row.reads as { id: string; revision: number | null }[]);
    for (const item of Object.values(row)) visit(item);
  };
  for (const row of store.list()) for (const revision of store.history(row.id)) visit(revision.value);
  return found;
}

test('PROOF-SPEED: an evaluation view still captures the run by its head — saved read sequences of earlier records replay as they are', async t => {
  const f = await applied(t);
  const runReads = capturedReads(f.store).filter(entry => entry.id === f.run);
  assert.ok(runReads.length > 0, 'the paid evaluation read the research run inside its captured view');
  assert.ok(runReads.every(entry => entry.revision === null), 'the captured selector stays the head read of the earlier era');
});

test('PROOF-SPEED: on the genuine Store an applied history is read as written — no historical proof runs, the result is the full derivation', async t => {
  const f = await applied(t);
  // An opaque view of the same Store reaches no genuine source: every reader derives the whole history in place, as before.
  const opaque = captureView(f.store).view;
  const readsBefore = storeReads(), derived = read(opaque, f), derivedReads = storeReads() - readsBefore;
  for (let i = 0; i < 3; i++) step(f.store, f.run);
  const before = historicalProofCounters(), trustedBefore = storeReads();
  assert.equal(read(f.store, f), derived, 'the saved application, state, accounts and assessment are exactly the derived ones');
  const trustedReads = storeReads() - trustedBefore, after = historicalProofCounters();
  assert.deepEqual([after.checks, after.loads, after.queued], [before.checks, before.loads, before.queued], 'no historical proof is derived, checked or loaded');
  assert.ok(trustedReads * 10 < derivedReads, `exact reads only: ${trustedReads} against ${derivedReads} of the full derivation`);
});

test('PROOF-SPEED: a cold Store reads the same applied history as written; an unapplied assessment is still proved and a run step does not touch it', async t => {
  const f = await applied(t);
  const hot = read(f.store, f);
  step(f.store, f.run);
  const cold = f.open(), before = historicalProofCounters();
  assert.equal(read(cold, f), hot, 'cold equals hot');
  assert.equal(historicalProofCounters().loads, before.loads, 'nothing to load: the applied history is read as written');
  const pending = await applied(t, false);
  const proved = canonical(readDiscoveryAssessment(pending.store, pending.project, pending.assessment) as never);
  for (let i = 0; i < 3; i++) step(pending.store, pending.run);
  const kept = historicalProofCounters();
  assert.equal(canonical(readDiscoveryAssessment(pending.store, pending.project, pending.assessment) as never), proved);
  assert.equal(historicalProofCounters().touched, kept.touched, 'the kept proof of an unapplied assessment does not depend on the run head');
});

test('PROOF-SPEED: a checkpoint takes an applied assessment by its saved application; an unapplied or foreign Ref has none', async t => {
  const f = await applied(t);
  const saved = savedV7ProgressApplication(f.store, f.assessment)!;
  assert.ok(saved, 'the applied assessment has its saved atomic application');
  assert.deepEqual(saved.value.assessment, f.assessment);
  assert.deepEqual(reference(saved), reference(readV7AssessmentReplay(f.store, f.project, f.assessment)!.applications[0]!),
    'the same exact application the full replay proves');
  assert.equal(savedV7ProgressApplication(f.store, { ...f.assessment, hash: '0'.repeat(64) }), null, 'another hash names no application');
  assert.equal(savedV7ProgressApplication(f.store, { ...f.assessment, revision: 2 }), null, 'another revision names no application');
});

test('PROOF-SPEED: saved records are read as written only where reads reach the genuine Store — never under a captured or overlay view', async t => {
  const f = await applied(t), run = f.store.get(f.run)!;
  assert.equal(historicalReadsReachGenuine(f.store), true, 'the genuine Store');
  assert.equal(historicalReadsReachGenuine(historicalTrace(f.store)), true, 'a transparent trace of it');
  assert.equal(historicalReadsReachGenuine(pendingSnapshotView(historicalTrace(f.store), [run])), true, 'a trusted snapshot over the trace');
  let atomic: boolean | null = null;
  f.store.atomicWrite(view => { atomic = historicalReadsReachGenuine(view); return { value: null, writes: [], guards: [] }; });
  assert.equal(atomic, true, 'the read-only view of an atomic write');
  assert.equal(historicalReadsReachGenuine(captureView(f.store).view), false, 'a capture view keeps its own reads');
  assert.equal(historicalReadsReachGenuine(pendingOverlay(f.store, [run])), false, 'a pending overlay is not the saved history');
  assert.equal(historicalReadsReachGenuine({}), false);
});

test('PROOF-SPEED: tampered bytes of a saved record stop a Discovery entry at om-fsck, before any read, call or write', async t => {
  const f = await applied(t);
  const target = f.store.get(f.assessment.id, f.assessment.revision)!;
  const run = f.store.get<ResearchRun>(f.run)!, calls = f.wires().length;
  // A change as someone other than the engine makes it: another connection, raw SQL, the immutability triggers dropped.
  const db = new DatabaseSync(f.path);
  for (const name of ['revisions_no_update', 'revisions_no_delete', 'events_no_update', 'events_no_delete']) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.prepare('UPDATE revisions SET body = ? WHERE entity_id = ? AND revision = ?')
    .run(JSON.stringify({ ...(target.value as object), forged: true }), target.id, target.revision);
  db.close();
  const store = f.open(), engine = new ProductEngine(store);
  const outcome = await engine.execute({ type: 'early-stage-run', project: 'p', maxTurns: 1, maxCalls: 1 }) as
    { end: string; reason: { code: string; target: string; message: string } | null; budget: { callsMade: number } };
  assert.equal(outcome.end, 'blocked');
  assert.equal(outcome.reason?.code, 'store_damaged');
  assert.equal(outcome.reason?.target, integrityId('p'));
  assert.match(outcome.reason!.message, new RegExp(`revision_corrupt ${target.id}@${target.revision}`));
  assert.equal(outcome.budget.callsMade, 0);
  assert.equal(f.wires().length, calls, 'no model call');
  assert.deepEqual(reference(store.get<ResearchRun>(f.run)!), reference(run), 'the run did not move');
  assert.ok(store.get(integrityId('p')), 'the found damage is saved for the owner');
});
