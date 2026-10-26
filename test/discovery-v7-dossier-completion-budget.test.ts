import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSubject, type VariantNone } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, StageBudgetSessions, issueStageBudgetInvitation,
  increaseStageBudget } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { runDossierAssessmentSession } from '../src/discovery/assessment-session.js';
import { readEffectiveStageBudget, DISCOVERY_V7_STAGE_BUDGET_KEY } from '../src/discovery/stage-token-budget.js';
import { budgetUsage, raiseWorkingLimit, type BudgetSegment } from '../src/runtime/research-budget.js';
import type { ModelCall } from '../src/runtime/model-usage.js';

function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
}
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
const all = (store: Store) => {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
    revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id,revision').all() } as never); }
  finally { db.close(); }
};
const dossierCalls = (store: Store) => store.list<ModelCall>('model-call').filter(row => row.value.purpose === 'dossier-assessor');
const STAGE = 20_000_000, RESERVE = 2_000_000;

/** The real paid line of the accepted 6.4 live-session scenarios, reduced to its non-empty partial dossier: two paid
 * assessed plan questions (one with rejected material), the snapshot, a real project mode, the real paid no_variants
 * generation, the handoff and the partial dossier. Nothing paid is fabricated. */
async function partial(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-dcr-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Dossier completion reserve' });
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const old = runs.get(selected.planAnswer.hash + selected.planQuestionId), run = old ? f.store.get<ResearchRun>(old)! : f.store.write<ResearchRun>({
      id: `research-run:${rand()}`, kind: 'research-run', expected: 0, value: { projectId: project, draftId: draft.id, environment: reference(f.environment),
        turns: 0, limit: 100, requestChars: 0, owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash + selected.planQuestionId, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst', rand()]), owner: reference(run), draft: reference(draft), question: reference(question),
      role: f.environment.value.implementer, dispatch: f.environment.value, profile: null, cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input), invoke = (store = f.store) => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const end = question === 'q-industry' ? { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT,
      value: { claims: [{ id: 'broad-rejected', kind: 'hypothesis', text: 'Real pre-choice rejected material', axis: 'industry',
        planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants: 'common' },
        basis: { howToVerify: 'Observe this bounded claim' } }] } } : undefined;
    const entry = await produce(g, end, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [],
      rejected: end ? [{ claim: { project, container: entry.attempt, containerKind: 'research-attempt', pointer: '/claims/0', claimId: 'broad-rejected' }, reason: 'Rejected by the real paid assessment' }] : [],
      newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
      methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
    const assessment = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
    applyDiscoveryAssessment(f.store, project, reference(assessment));
  }
  const saved = produceVariantSnapshot(f.store, project).record;
  const modeSessions = new ProjectModeSessions(f.store), invite = ok(issueProjectModeInvitation(f.store, { project, mode: 'questions', previous: null }));
  const exchanged = ok(modeSessions.exchange({ project, invitation: invite.invitation }));
  const questions = setProjectMode(f.store, { project, mode: 'questions', previous: null }, modeSessions.authority(exchanged.bearer)).record;
  ok(modeSessions.revoke(exchanged.bearer));
  const subject: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(saved), mode: reference(questions), expectedSelection: null };
  const calibration = f.store.write({ id: 'transport-fixture:scope-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  const none = { action: 'no_variants', reasons: [{ code: 'bounded_search', message: 'No bounded variant', grounds: [reference(saved)] }],
    searchLimits: ['Saved sweep'], unknowns: ['Demand unknown'] };
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer]) {
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: { ...none, reasons: [{ ...none.reasons[0], grounds: [reference(calibration)] }] } }));
    await researchCall(role, f.environment.value, 'Calibrate generation', { variantSubject: { ...subject, snapshot: reference(calibration) }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  }
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: none }));
  await runVariantSession(f.store, { projectId: project, environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Propose variants from this exact paid sweep', variantSubject: subject });
  const found = f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const draft = reference(f.store.get(f.v.draft.id)!);
  const handoff = await publishVariantHandoff(f.store, 'p', { draft, result: reference(found), decision: null, scope: null, earlyLimit: false });
  const root = reference((await producePartialDossier(f.store, 'p', reference(handoff.record))).record);
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', root);
  return { ...g, packet };
}
type Fixture = Awaited<ReturnType<typeof partial>>;

function replyFor(packet: DossierAssessmentPacket): DossierAssessmentResult {
  const bases = [{ record: packet.manifest.ref }];
  return { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: structuredClone(packet.subject), verdict: 'supported',
    reasons: ['The saved dossier is assessed at its own boundary'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(dimension => [dimension,
      { judgement: 'adequate', reason: `Reviewed ${dimension} against the saved goal and scale`, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(item => item.address), unknowns: packet.unknowns.map(item => item.unknown.claim),
      contradictions: packet.contradictions.map(item => ({ id: item.contradiction.id,
        sides: item.sides.map(side => side.address) as [ClaimAddress, ClaimAddress], grounds: item.grounds.map(record => record.ref) })) },
    return: null };
}
/** The accepted live dossier adapter in its single-step form: the terminal assessment at the first managed step. */
function dossierAdapter(f: Fixture, tokens = 10) {
  writeFileSync(f.settings, JSON.stringify({ tokens, terminal: replyFor(f.packet) }));
  writeFileSync(f.root + '/adapter.mjs', `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(f.settings)},'utf8'));
appendFileSync(${JSON.stringify(f.root + '/wire.ndjson')},raw+'\\n');
const research=r.subject.managedDossier?.step===undefined?s.reply:s.terminal;
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:s.tokens??10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
}
function stage(store: Store) {
  const segment = readEffectiveStageBudget(store, 'p').segment as Revision<BudgetSegment>;
  const usage = budgetUsage(store, segment);
  return { segment, usage, total: segment.value.limit - usage.measured - usage.reserved };
}
/** A real paid ordinary v7 analyst send whose measured usage leaves exactly `rest` tokens of the whole stage. The
 * prepared adapter answers impossible; its usage, not a written budget row, consumes the research part. */
async function burn(f: Fixture, rest: number, store = f.store, question = 'q-market') {
  const before = stage(store), tokens = before.total - rest - 1;
  assert.ok(tokens > 0, `cannot leave ${rest} of ${before.total}`);
  const turn = f.prepare(f.subject(question));
  writeFileSync(f.settings, JSON.stringify({ tokens, reply: { action: 'answer', question,
    value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'No source' }, citations: [] } }));
  await turn.invoke(store);
  assert.equal(stage(store).total, rest);
  return turn;
}
/** Intercept only writes of the given Store: the shared runtime keeps every read real. */
function intercept(t: test.TestContext, target: Store, action: (writes: any[], commit: () => any) => any) {
  const original = Store.prototype.writeMany;
  const method = t.mock.method(Store.prototype, 'writeMany', function (this: Store, writes: any[], guards: any[] = []) {
    const commit = () => original.call(this, writes, guards);
    return this === target ? action(writes, commit) : commit();
  });
  return () => method.mock.restore();
}
const isReservation = (writes: any[]) => writes.some(w => w.kind === 'model-call' && w.value?.purpose === 'dossier-assessor');
async function inert(f: Fixture, store: Store, action: () => Promise<unknown>, check: (error: unknown) => boolean) {
  const before = all(store), paid = money(store), wires = f.wires().length;
  await assert.rejects(action, check);
  assert.equal(all(store), before); assert.deepEqual(money(store), paid); assert.equal(f.wires().length, wires);
}
const refusal = (code: string, cls: string, remaining?: number) => (error: unknown) => error instanceof EngineError && error.code === code
  && (error.details as any)?.class === cls && (remaining === undefined || (error.details as any)?.remaining === remaining);

test('DR6: after real measured research exhaustion ordinary research is refused and the proven dossier assessment completes from the reserve', async t => {
  const f = await partial(t);
  await burn(f, RESERVE);
  assert.equal(stage(f.store).total - RESERVE, 0);
  // Ordinary research — also a caller claiming finalization/completion in its context — keeps the research class.
  const next = f.prepare(f.subject('q-industry'));
  for (const store of [f.store, f.open()])
    await inert(f, store, () => next.invoke(store), refusal('discovery_budget_reserve', 'research', 0));
  for (const context of [{ finalization: true }, { completion: true, history: [], readings: [] }, { closingKind: 'dossier' }])
    await inert(f, f.store, () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store: f.store, draftId: f.v.draft.id, questionId: f.v.plan.id, purpose: 'analyst' }), error => error instanceof EngineError);
  // A purpose alone is no dossier admission: the raw dossier entry stays closed before any budget.
  await inert(f, f.store, () => researchCall(f.environment.value.reviewer, f.environment.value, 'Assess', { history: [] }, undefined,
    { store: f.store, draftId: f.v.draft.id, questionId: f.v.plan.id, purpose: 'dossier-assessor' }),
    error => error instanceof EngineError && !['discovery_budget_reserve', 'discovery_budget_overrun'].includes(error.code));
  dossierAdapter(f);
  const before = stage(f.store), result = await runDossierAssessmentSession(f.store, 'p', f.packet.subject, f.environment);
  assert.ok(result.result);
  const calls = dossierCalls(f.store);
  assert.equal(calls.length, 1);
  const after = stage(f.store);
  assert.ok(after.usage.measured > before.usage.measured && after.total >= 0 && after.usage.measured <= STAGE);
  assert.ok(calls[0]!.value.budget && calls[0]!.value.budget.segment.id === before.segment.id);
  assert.deepEqual(after.usage.ledger!.value.assignments.at(-1)!.call, calls[0]!.id);
  // The paid result repeats free hot and cold although no research and no new reserve fund remains for a send.
  for (const store of [f.store, f.open()]) {
    const snapshot = all(store), paid = money(store), wires = f.wires().length;
    assert.deepEqual(await runDossierAssessmentSession(store, 'p', f.packet.subject, f.environment), result);
    assert.equal(all(store), snapshot); assert.deepEqual(money(store), paid); assert.equal(f.wires().length, wires);
  }
});

/** The first managed step's own forecast, read from the reservation it would write; the cut before that commit leaves
 * the recoverable prepared position and no call, ledger row or wire. */
async function forecast(t: test.TestContext, f: Fixture) {
  dossierAdapter(f);
  let estimate = 0;
  const restore = intercept(t, f.store, (writes, commit) => {
    if (!estimate && isReservation(writes)) {
      estimate = writes.find(w => w.kind === 'model-call').value.budget.estimate.tokens; throw new Error('cut-before-reservation');
    }
    return commit();
  });
  await assert.rejects(() => runDossierAssessmentSession(f.store, 'p', f.packet.subject, f.environment), /cut-before-reservation/);
  restore();
  assert.ok(estimate > 0 && estimate < RESERVE); assert.equal(dossierCalls(f.store).length, 0);
  return estimate;
}

test('DR6: the boundary is the whole stage — exactly the forecast is admitted, one token less refuses as completion after a second-Store spend', async t => {
  for (const missing of [0, 1]) {
    const f = await partial(t), estimate = await forecast(t, f);
    // The second Store's real measured spend lands between the forecast and the reservation of the original position.
    const other = f.open();
    await burn(f, estimate - missing, other);
    dossierAdapter(f);
    if (missing) {
      for (const store of [f.store, f.open()])
        await inert(f, store, () => runDossierAssessmentSession(store, 'p', f.packet.subject, f.environment),
          refusal('discovery_budget_reserve', 'completion', estimate - 1));
      const next = f.prepare(f.subject('q-industry'));
      await inert(f, f.store, () => next.invoke(), refusal('discovery_budget_reserve', 'research', estimate - 1 - RESERVE));
    } else {
      const result = await runDossierAssessmentSession(f.store, 'p', f.packet.subject, f.environment);
      assert.ok(result.result);
      const calls = dossierCalls(f.store);
      assert.equal(calls.length, 1); assert.equal(calls[0]!.value.budget!.estimate.tokens, estimate);
      assert.ok(stage(f.store).usage.measured <= STAGE);
    }
  }
});

test('DR6: unknown usage stays reserved and a measured overrun forbids the next purchase to both classes', async t => {
  const f = await partial(t), estimate = await forecast(t, f);
  // A cut after the committed reservation and before any response: the call keeps its reserve as unknown usage.
  dossierAdapter(f);
  const restore = intercept(t, f.store, (writes, commit) => {
    const rows = commit(); if (isReservation(writes)) throw new Error('cut-after-reservation'); return rows;
  });
  await assert.rejects(() => runDossierAssessmentSession(f.store, 'p', f.packet.subject, f.environment), /cut-after-reservation/);
  restore();
  const pending = stage(f.store);
  assert.equal(dossierCalls(f.store).length, 1); assert.equal(dossierCalls(f.store)[0]!.value.usage, null);
  // The unknown usage occupies its reserve in the shared accounting of both classes.
  assert.ok(pending.usage.reserved >= estimate);
  assert.equal(pending.total, STAGE - pending.usage.measured - pending.usage.reserved);
  // A second project-wide real send over-reports beyond the whole limit.
  const g = await partial(t);
  await forecast(t, g);
  await burn(g, -5);
  assert.ok(stage(g.store).usage.measured > STAGE);
  dossierAdapter(g);
  for (const store of [g.store, g.open()])
    await inert(g, store, () => runDossierAssessmentSession(store, 'p', g.packet.subject, g.environment), refusal('discovery_budget_overrun', 'completion'));
  const late = g.prepare(g.subject('q-industry'));
  await inert(g, g.store, () => late.invoke(), refusal('discovery_budget_overrun', 'research'));
});

test('DR6: a paid dossier response cut before its application recovers free after the stage is spent; history is not reclassified', async t => {
  const f = await partial(t);
  await burn(f, RESERVE);
  const researchCalls = money(f.store).calls.filter((row: any) => row.value.purpose !== 'dossier-assessor');
  // The terminal's own measured usage spends the whole remaining stage.
  dossierAdapter(f, stage(f.store).total - 1);
  const restore = intercept(t, f.store, (writes, commit) => {
    const rows = commit(); if (writes.some(w => w.kind === 'model-response')) throw new Error('cut-after-response'); return rows;
  });
  await assert.rejects(() => runDossierAssessmentSession(f.store, 'p', f.packet.subject, f.environment), /cut-after-response/);
  restore();
  assert.equal(stage(f.store).total, 0);
  for (const store of [f.store, f.open()]) {
    const wires = f.wires().length;
    const result = await runDossierAssessmentSession(store, 'p', f.packet.subject, f.environment);
    assert.ok(result.result); assert.equal(f.wires().length, wires); assert.equal(dossierCalls(store).length, 1);
  }
  assert.deepEqual(money(f.store).calls.filter((row: any) => row.value.purpose !== 'dossier-assessor'), researchCalls);
});

function ownerRaise(f: Fixture, limit: number) {
  const head = stage(f.store).segment, scope = { project: 'p', stage: 'discovery' as const, previous: reference(head), limit };
  const sessions = new StageBudgetSessions(f.store), issued = ok(issueStageBudgetInvitation(f.store, scope));
  const opened = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  const raised = increaseStageBudget(f.store, scope, sessions.authority(opened.bearer)); ok(sessions.revoke(opened.bearer));
  return raised;
}

test('DR6: an owner raise of the stage limit is not a working-limit raise — the purchase refuses typed by the group limit', async t => {
  const f = await partial(t);
  await forecast(t, f);
  await burn(f, 0);
  dossierAdapter(f);
  await inert(f, f.store, () => runDossierAssessmentSession(f.store, 'p', f.packet.subject, f.environment),
    error => refusal('discovery_budget_reserve', 'completion', 0)(error) && ((error as EngineError).details as any)?.cause === 'budget_segment_exhausted');
  const before = stage(f.store);
  ownerRaise(f, STAGE + 1_000_000);
  const raised = stage(f.store);
  assert.equal(raised.segment.value.limit, STAGE + 1_000_000); assert.equal(raised.total, 1_000_000);
  assert.equal(raised.segment.value.initialGroupLimit, STAGE); assert.equal(raised.segment.value.completionReserve, RESERVE);
  assert.deepEqual([raised.usage.measured, raised.usage.reserved], [before.usage.measured, before.usage.reserved]);
  // The whole 21M is not exhausted: the refusal names the working group limit as its cause.
  for (const store of [f.store, f.open()])
    await inert(f, store, () => runDossierAssessmentSession(store, 'p', f.packet.subject, f.environment),
      error => refusal('discovery_budget_reserve', 'completion', 1_000_000)(error) && ((error as EngineError).details as any)?.cause === 'budget_question_limit');
});

test('DR6: with an owner raise and a separate justified working raise the proven completion purchase is admitted and repeats free', async t => {
  const f = await partial(t);
  await forecast(t, f);
  await burn(f, 0);
  ownerRaise(f, 24_000_000);
  const raised = stage(f.store), spent = raised.usage.measured;
  const decision = { reason: 'The proven dossier assessment of the partial dossier remains after the measured stage spend',
    progress: `measured stage spend ${spent} with the prepared dossier position saved`, required: STAGE + 1_000_000,
    options: [{ method: 'Skip the dossier assessment', saved: 1_000_000, decision: 'reject' as const, quality: 'Leaves the partial dossier unassessed', preserved: [] }],
    obligations: ['Assess the saved partial dossier at its own boundary'], forecast: 'One managed dossier step within the raised stage',
    basis: [reference(raised.segment), raised.usage.ledger ? reference(raised.usage.ledger) : reference(raised.segment)] };
  raiseWorkingLimit(f.store, raised.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', raised.segment.value.initialGroupLimit, decision, 24_000_000);
  dossierAdapter(f);
  const result = await runDossierAssessmentSession(f.store, 'p', f.packet.subject, f.environment);
  assert.ok(result.result); assert.equal(dossierCalls(f.store).length, 1);
  const after = stage(f.store);
  assert.ok(after.usage.measured > spent && after.usage.measured <= 24_000_000);
  assert.equal(after.segment.value.completionReserve, RESERVE);
  for (const store of [f.store, f.open()]) {
    const snapshot = all(store), paid = money(store), wires = f.wires().length;
    assert.deepEqual(await runDossierAssessmentSession(store, 'p', f.packet.subject, f.environment), result);
    assert.equal(all(store), snapshot); assert.deepEqual(money(store), paid); assert.equal(f.wires().length, wires);
  }
});
