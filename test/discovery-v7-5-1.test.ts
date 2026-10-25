import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, completeResearchAttemptTurn, researchConsumerIntentId,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { computeMissingCoverage, coverageCellKey } from '../src/discovery/coverage.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import type { V7AttemptEnd } from '../src/discovery/v7-plan-questions.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { managedTurnId, projectPaidTurnAdmission } from '../src/discovery/research-consumer-transition.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { VariantChoiceSessions, issueVariantChoiceInvitation, ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand, validPlan } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { questionOf } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';

// The main 5.1 (codex-omg2 №12393, the №9147 line): the proof-based computation of the missing coverage — question ×
// exact set/member × requiredDepth × criterion from the exact accepted plan, the variant from the proven scope of
// 4P.1, the grounds through proveClaimAddress (acceptance by the first application of a paid assessment). Common
// material, a foreign member, another plan edition, an unapplied or rejected claim and a structural lookalike never
// close a variant cell; the projection is read-only and a later head never rewrites it.
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
const refuses = (invoke: () => unknown, expected?: string) => assert.throws(invoke, (error: unknown) =>
  error instanceof EngineError && (!expected || error.code === expected));
const asJson = <T>(value: T): Json => value as unknown as Json;
const exact = (record: Revision<unknown>): Ref => ({ id: record.id, revision: record.revision, hash: record.hash });
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
}
const judgement = { conclusion: 'Bounded by the paid sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the saved sweep'], quantity: null };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'Same shared scale']));
const generation = () => ({ action: 'variants', variants: [1, 2].map(i => ({ key: `v${i}`, title: `Variant ${i}`, proposal: { scope: `scope-${i}` }, criteria })),
  scale, comparison: 'Two bounded variants on one scale', recommendation: { key: 'v2', reason: 'The generation recommends the wider one' },
  searchLimits: ['Only the saved sweep'], unknowns: [] });

/** The real paid variant line of 4P.1 with its published scope, plus the claims machinery of one research run on the
 * same draft: managed attempts with hypothesis claims and their paid applied assessments. */
async function paid(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-51-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Coverage computation' });
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] };
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!, question = f.store.get<Question>(f.v.plan.id)!;
    const old = runs.get(selected.planAnswer.hash), run = old ? f.store.get<ResearchRun>(old)! : f.store.write<ResearchRun>({
      id: `research-run:${rand()}`, kind: 'research-run', expected: 0, value: { projectId: project, draftId: draft.id, environment: reference(f.environment),
        turns: 0, limit: 100, requestChars: 0, owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run), draft: reference(draft), question: reference(question),
      role: f.environment.value.implementer, dispatch: f.environment.value, profile: null, cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input), invoke = () => researchCall(f.environment.value.implementer, f.environment.value, f.prompt, context, undefined,
      { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const entry = await produce(g, undefined, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
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
  const reply = (value: unknown) => writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: value }));
  const subject: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(saved), mode: reference(questions), expectedSelection: null };
  const calibration = f.store.write({ id: 'transport-fixture:51-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer]) {
    reply(generation());
    await researchCall(role, f.environment.value, 'Calibrate generation', { variantSubject: { ...subject, snapshot: reference(calibration) }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  }
  reply(generation());
  await runVariantSession(f.store, { projectId: project, environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Propose variants from this exact paid sweep', variantSubject: subject });
  const set = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === project)!;
  const draft = set.value.draft, state1 = f.store.get<VariantState>(variantStateId(project, draft.id))!;
  const scope: VariantChoiceScope = { action: VARIANT_OWNER_ACTION, projectId: project, draft, set: reference(set), mode: reference(questions),
    operation: 'initial', previous: null, expectedSelection: reference(state1), outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'The exact paid set fits the owner goal' } };
  const sessions = new VariantChoiceSessions(f.store), issued = ok(issueVariantChoiceInvitation(f.store, scope));
  const login = ok(sessions.exchange({ projectId: project, invitation: issued.invitation }));
  const act = answerVariantChoice(f.store, scope, sessions.authority(login.bearer));
  const published = publishVariantScope(f.store, project, reference(act.decision));
  return { ...g, project, runs, planQuestions: f.questions, questions, reply, set, draft, state1, scope, act, published };
}
type Paid = Awaited<ReturnType<typeof paid>>;

/* ---------- the claims machinery of the paid draft ---------- */

/** The claims ride the paid line's own managed run — the progress chain keeps one run per subject. */
const claimsLine = (f: Paid) => ({ draft: f.store.get<DiscoveryDraft>(f.v.draft.id)!, plan: f.store.get<Question>(f.v.plan.id)!,
  planAnswer: f.v.planAnswer, runId: f.runs.get(f.v.planAnswer.hash)! });
type ClaimsLine = ReturnType<typeof claimsLine>;
const planLink = (v: ClaimsLine, planQuestionId: string) => [{ planAnswer: asJson(v.planAnswer), planQuestionId }];
function hypothesisClaim(v: ClaimsLine, planQuestionId: string, text: string, variants: 'common' | Ref[]): Json {
  return { id: `hyp-${rand()}`, kind: 'hypothesis', text, axis: 'market', planQuestions: planLink(v, planQuestionId),
    scope: { variants: asJson(variants) }, basis: { howToVerify: 'A named quote of the chosen variant' } } as unknown as Json;
}
const submitted = (...claims: Json[]): V7AttemptEnd => ({ type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } });
const writeRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
function managedTurn(f: Paid, v: ClaimsLine, planQuestionId: string, end: V7AttemptEnd) {
  const store = f.store, project = f.project;
  const subject = { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: v.planAnswer, planQuestionId };
  let run = store.get<ResearchRun>(v.runId);
  if (run === null) run = store.write<ResearchRun>({ id: v.runId, kind: 'research-run', expected: 0, value: {
    projectId: project, draftId: v.draft.id, environment: reference(v.draft), status: 'running', turns: 0, limit: 50,
    inputs: [], ownerQuestion: null, error: null, pauseCode: null, owner: { pid: 1, started: 'fixture' }, requestChars: 0 } });
  const number = run.value.turns + 1, key = `v7-attempt-${rand()}`, owner = reference(run);
  const intentValue: ResearchConsumerIntent = { contract: 'research-consumer-intent/v1', projectId: project,
    kind: 'analyst', key, rootKey: key, generation: 0, previous: null, owner,
    draft: reference(v.draft), question: reference(v.plan),
    role: { actor: 'fixture', model: 'fixture', effort: 'medium', command: { executable: 'fixture', args: [] } },
    dispatch: { projectId: project } as unknown as ResearchConsumerIntent['dispatch'], profile: null,
    cursor: { context: {}, prompt: 'Research the plan-question', run: v.runId, turn: number, subject },
    basis: [], guards: uniqueTransactionGuards([owner, reference(v.draft), reference(v.plan)]),
    state: 'prepared', call: null, request: null, archive: null, outputs: null, refusal: null };
  const intentId = researchConsumerIntentId(project, 'analyst', key, 0);
  const intent1 = store.write<ResearchConsumerIntent>({ id: intentId, kind: 'research-consumer-intent', expected: 0, value: intentValue });
  const call = store.write({ id: `model-call:consumer:v1:${rand()}`, kind: 'model-call', expected: 0,
    value: { projectId: project, draftId: v.draft.id, questionId: planQuestionId, planAnswer: asJson(v.planAnswer),
      purpose: 'analyst', requestId: `r-${rand()}`, consumerIntent: asJson(reference(intent1)),
      startedAt: 1, finishedAt: 2, status: 'succeeded', requested: asJson(intentValue.role),
      confirmed: { model: 'fixture', effort: 'medium', speed: null },
      request: { chars: 10, bytes: 10, hash: hashJson('req') }, response: { chars: 20, bytes: 20 },
      usage: null, usageSource: 'unavailable', error: null } as unknown as Record<string, Json> });
  const intent2 = store.write<ResearchConsumerIntent>({ id: intentId, kind: 'research-consumer-intent', expected: 1,
    value: { ...intentValue, state: 'running', call: reference(call), request: reference(call), archive: reference(call) } });
  const projected = projectPaidTurnAdmission(run.value, { runId: v.runId, intent: reference(intent1),
    response: { action: 'answer', question: planQuestionId, value: asJson(end), citations: [] },
    question: reference(v.plan), owner: run.value.owner, limit: 50, context: {}, subject });
  const runWrite: Write = { id: v.runId, kind: 'research-run', expected: run.revision, value: projected.run };
  const turnWrite: Write = { id: managedTurnId(v.runId, number), kind: 'research-turn', expected: 0, value: projected.turn };
  const appliedWrite: Write = { id: intentId, kind: 'research-consumer-intent', expected: 2,
    value: { ...intent2.value, state: 'applied', outputs: [writeRef(runWrite), writeRef(turnWrite)] } };
  const [, turn] = store.writeMany([runWrite, turnWrite, appliedWrite]);
  return { call, turn: turn as unknown as Revision<unknown>, number };
}
type Claimed = { attempt: Ref; binding: Ref; claims: Json[] };
function attempt(f: Paid, v: ClaimsLine, planQuestionId: string, claims: Json[]): Claimed {
  const end = submitted(...claims);
  const chain = managedTurn(f, v, planQuestionId, end);
  const recorded = recordV7Attempt(f.store, { project: f.project, planAnswer: v.planAnswer, planQuestionId,
    call: reference(chain.call as Revision<unknown>), end }).attempt;
  const done = completeResearchAttemptTurn(f.store, f.project, reference(chain.turn), reference(recorded));
  return { attempt: exact(recorded), binding: exact(done.binding), claims };
}
const addressOf = (f: Paid, a: Claimed, index: number): ClaimAddress => ({ project: f.project, container: a.attempt,
  containerKind: 'research-attempt', pointer: `/claims/${index}`,
  claimId: (a.claims[index] as Record<string, Json>)['id'] as string });
/** A paid assessment over the claim attempts; `apply` decides whether its acceptance is applied to progress. */
async function assess(f: Paid, planQuestionId: string, claimed: Claimed[], accept: boolean) {
  const packet = projectAttemptPacket(f.store, { project: f.project, planAnswer: f.v.planAnswer, planQuestionId,
    entries: claimed.map(item => ({ attempt: item.attempt, binding: item.binding })) });
  const rows = claimed.flatMap(item => item.claims.map((_, index) => addressOf(f, item, index)));
  const classified = accept
    ? { accepted: rows.map(claim => ({ claim, reason: 'Covers the chosen variant' })), rejected: [],
      newContent: rows.map(claim => ({ claim, reason: 'New variant ground' })), duplicates: [], noProgress: [] }
    : { accepted: [], rejected: rows.map(claim => ({ claim, reason: 'Rejected by the assessor' })),
      newContent: [], duplicates: [], noProgress: claimed.map(item => ({ attempt: item.attempt, reason: 'No acknowledged basis' })) };
  const reply = { verdict: 'supported', reasons: ['Paid assessment'], return: null,
    novelty: { attempts: claimed.map(item => ({ attempt: item.attempt, reason: 'Exact result' })), ...classified, transition: null },
    methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
  return await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
}

test('5.1: the chosen variant cell is covered by its proven applied ground; the neighbouring question names its addressed missing', async t => {
  const f = await paid(t), v = claimsLine(f), [member] = f.set.value.members;
  const claimed = attempt(f, v, 'q-industry', [hypothesisClaim(v, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [claimed], true)));
  const report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  assert.equal(report.verification, 'proven');
  assert.deepEqual([report.set, report.member], [reference(f.set), member]);
  assert.equal(report.cells.length, 2, 'one cell per plan question');
  const [industry, market] = report.cells;
  assert.equal(industry!.cell.subject.planQuestionId, 'q-industry');
  assert.equal(industry!.cell.requiredDepth, 'deep');
  assert.equal(industry!.cell.criterion, 'Named basis answering q-industry');
  assert.deepEqual(industry!.cell.variant, { set: reference(f.set), member: member! });
  assert.equal(industry!.covered, true);
  assert.equal(industry!.grounds.length, 1);
  assert.deepEqual(industry!.grounds[0]!.claim, addressOf(f, claimed, 0));
  assert.equal(industry!.grounds[0]!.variants.length, 1);
  assert.match(industry!.grounds[0]!.contentKey, /^[0-9a-f]{64}$/, 'the ground keeps its semantic content key');
  assert.equal(market!.covered, false);
  assert.equal(market!.missing!.code, 'coverage_no_applied_grounds');
  assert.deepEqual(report.missing.map(cell => cell.cell.subject.planQuestionId), ['q-market']);
  // The computation is a read-only projection: hot and cold give the same answer with nothing written or paid.
  const before = history(f.store), accounting = money(f.store), sent = f.wires().length;
  const cold = new Store(f.store.path); t.after(() => cold.close());
  assert.deepEqual(computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer), report);
  assert.deepEqual(computeMissingCoverage(cold, f.project, reference(f.published.scope), f.v.planAnswer), report);
  assert.deepEqual(history(f.store), before); assert.deepEqual(money(f.store), accounting); assert.equal(f.wires().length, sent);
});

test('5.1: common material and a foreign member never close the variant cell — the addressed reason names them', async t => {
  const f = await paid(t), v = claimsLine(f), [, other] = f.set.value.members;
  const common = attempt(f, v, 'q-industry', [hypothesisClaim(v, 'q-industry', 'Common market material', 'common')]);
  const foreign = attempt(f, v, 'q-industry', [hypothesisClaim(v, 'q-industry', 'Scoped to the other member, however titled', [other!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [common, foreign], true)));
  const report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  const industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, false, 'a matching variant name of another member and common material cover nothing');
  assert.equal(industry.missing!.code, 'coverage_no_variant_ground');
  assert.equal(industry.common.length, 1, 'the common material stays listed with its provenance');
  assert.equal(industry.grounds.length, 0);
  assert.deepEqual(report.missing.map(cell => cell.cell.subject.planQuestionId).sort(), ['q-industry', 'q-market']);
});

test('5.1: a merely paid but unapplied acceptance, a rejected claim and a structural lookalike give no coverage; applying completes the chain', async t => {
  const f = await paid(t), v = claimsLine(f), [member] = f.set.value.members;
  void member;
  const claimed = attempt(f, v, 'q-industry', [hypothesisClaim(v, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  const paidAssessment = await assess(f, 'q-industry', [claimed], true);
  let report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  let industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, false, 'a paid but unapplied acceptance covers nothing yet');
  assert.equal(industry.missing!.code, 'coverage_no_applied_grounds');
  applyDiscoveryAssessment(f.store, f.project, reference(paidAssessment));
  report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, true, 'applying the paid acceptance completes the proven chain');
  // An explicit negative AFTER the lawful chain: a forged next progress-state revision claims the cell closed with a
  // count it never earned. The computation proves its grounds through their own door and never reads the summary —
  // the coverage and its exact grounds stay as they were proven.
  const stateId = v7ProgressStateId({ project: f.project, planAnswer: f.v.planAnswer, planQuestionId: 'q-industry' });
  const head = f.store.get(stateId);
  f.store.write({ id: stateId, kind: 'v7-progress-state', expected: head ? head.revision : 0,
    value: { contract: 'v7-progress-state/v1', subject: { project: f.project, planAnswer: asJson(f.v.planAnswer), planQuestionId: 'q-industry' },
      application: { id: 'forged', revision: 1, hash: '0'.repeat(64) },
      summary: { cursor: null, count: 99, streak: 9, outcome: 'closed', reason: 'Forged closed summary', nextAction: null } } as never });
  const afterForgery = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  const after = afterForgery.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(after.covered, true, 'a structural lookalike summary neither adds nor removes proven coverage');
  assert.deepEqual(after.grounds, industry.grounds);
  const rejected = attempt(f, v, 'q-market', [hypothesisClaim(v, 'q-market', 'A rejected ground of the second member', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-market', [rejected], false)));
  const market = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer)
    .cells.find(cell => cell.cell.subject.planQuestionId === 'q-market')!;
  assert.equal(market.covered, false, 'a rejected claim covers nothing');
  assert.equal(market.missing!.code, 'coverage_no_applied_grounds');
});

test('5.1: another plan edition keeps the old projection and starts the new cells empty; the same planQuestionId proves nothing', async t => {
  const f = await paid(t), v = claimsLine(f), [member] = f.set.value.members;
  const claimed = attempt(f, v, 'q-industry', [hypothesisClaim(v, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [claimed], true)));
  const first = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  assert.equal(first.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!.covered, true);
  // The next lawful plan edition: the plan question reopens and is accepted again, with another required depth.
  const plan = questionOf(f.store, f.store.get<DiscoveryDraft>(f.v.draft.id)!, 'plan');
  f.discovery.reopen(plan.id, plan.revision);
  const reopened = f.store.get<Question>(plan.id)!;
  const source = f.discovery.evidence.document(f.project, `basis-edition-${rand()}`, 'Exact source for the next edition', 'text/plain', 0);
  answerDiscoveryFixture(f.engine, f.project, f.store.get<DiscoveryDraft>(f.v.draft.id)!, reopened,
    validPlan(f.v.frameRef, f.planQuestions, 2, f.v.planAnswer), source);
  const secondAnswer = f.store.get<Question>(plan.id)!.value.answer!;
  assert.notDeepEqual(secondAnswer, f.v.planAnswer);
  const oldProjection = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  assert.deepEqual(oldProjection, first, 'the historical projection keeps its own edition');
  const edition = computeMissingCoverage(f.store, f.project, reference(f.published.scope), secondAnswer);
  const industry = edition.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, false, 'the applied ground served the previous edition only');
  assert.equal(industry.missing!.code, 'coverage_no_applied_grounds');
  // Another depth or criterion is another cell address — the pure key of the closed form says so directly.
  const deeper = { ...industry.cell, requiredDepth: 'exhaustive' };
  assert.notEqual(coverageCellKey(deeper), industry.key, 'another depth is another cell');
  assert.notEqual(coverageCellKey({ ...industry.cell, criterion: 'Another named basis' }), industry.key,
    'another criterion is another cell');
});

test('5.1: later heads never rewrite the old projection — a revise, a mode move and a restart keep the covered answer', async t => {
  const f = await paid(t), v = claimsLine(f), [member] = f.set.value.members;
  const claimed = attempt(f, v, 'q-industry', [hypothesisClaim(v, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [claimed], true)));
  const original = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  const rejection: VariantChoiceScope = { ...f.scope, operation: 'revise', previous: reference(f.act.decision),
    expectedSelection: reference(f.act.state), outcome: { kind: 'reject_all', reason: 'Owner rejects this exact set' } };
  answerVariantChoice(f.store, rejection, mint(f.store, rejection).authority);
  const previous = f.store.get('project-mode:p');
  const modeScope = { project: 'p', mode: 'bypass' as const, previous: previous ? reference(previous) : null };
  const sessions = new ProjectModeSessions(f.store), issued = ok(issueProjectModeInvitation(f.store, modeScope));
  const login = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  setProjectMode(f.store, modeScope, sessions.authority(login.bearer));
  const cold = new Store(f.store.path); t.after(() => cold.close());
  const snapshot = { history: history(f.store), accounting: money(f.store), sent: f.wires().length };
  assert.deepEqual(computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer), original,
    'the historical projection stays exactly as it was');
  assert.deepEqual(computeMissingCoverage(cold, f.project, reference(f.published.scope), f.v.planAnswer), original,
    'and reads the same after a restart');
  assert.deepEqual(history(f.store), snapshot.history); assert.deepEqual(money(f.store), snapshot.accounting);
  assert.equal(f.wires().length, snapshot.sent);
  refuses(() => computeMissingCoverage(f.store, 'foreign', reference(f.published.scope), f.v.planAnswer));
  refuses(() => computeMissingCoverage(f.store, f.project, { ...reference(f.published.scope), hash: '0'.repeat(64) }, f.v.planAnswer),
    'discovery_variant_basis_invalid');
});

const mint = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const exchanged = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...exchanged, authority: sessions.authority(exchanged.bearer)! };
};
