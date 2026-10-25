import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
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
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { VariantChoiceSessions, issueVariantChoiceInvitation, ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand, validPlan, questionOf } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import type { OmResult } from '../src/om/refusal.js';

// The main 5.1 (codex-omg2 №12393, the №9147 line, P2 fixes of №12522): the proof-based computation of the missing
// coverage. A cell closes only on a proven applied closed sufficiency of the plan question's own criterion and depth
// standing on the chosen member's own ground; an accepted claim without it stays material. Positive chains run through
// the standard producers only — no hand-made paid or progress records.
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
const refuses = (invoke: () => unknown, expected?: string) => assert.throws(invoke, (error: unknown) =>
  error instanceof EngineError && (!expected || error.code === expected));
const asJson = <T>(value: T): Json => value as unknown as Json;
const isRefLike = (value: unknown): value is Ref =>
  typeof value === 'object' && value !== null && typeof (value as Ref).id === 'string';
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

/** The real paid variant line of 4P.1 with its published scope; every claims attempt runs through the standard paid
 * producers of the fixture (the same produce the baseline assessments above use). */
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
  return { ...g, project, reply, set, draft, state1, scope, act, published };
}
type Paid = Awaited<ReturnType<typeof paid>>;

function hypothesisClaim(f: Paid, planQuestionId: string, text: string, variants: 'common' | Ref[]): Json {
  return { id: `hyp-${rand()}`, kind: 'hypothesis', text, axis: 'market',
    planQuestions: [{ planAnswer: asJson(f.v.planAnswer), planQuestionId }],
    scope: { variants: asJson(variants) }, basis: { howToVerify: 'A named quote of the chosen variant' } } as unknown as Json;
}
const submitted = (...claims: Json[]): V7AttemptEnd => ({ type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } });
type Claimed = { attempt: Ref; binding: Ref; claims: Json[] };
/** One claims attempt through the standard paid producers of the fixture. */
async function claimAttempt(f: Paid, planQuestionId: string, claims: Json[]): Promise<Claimed> {
  const entry = await produce(f, submitted(...claims), planQuestionId);
  return { ...entry, claims };
}
const addressOf = (f: Paid, a: Claimed, index: number): ClaimAddress => ({ project: f.project, container: a.attempt,
  containerKind: 'research-attempt', pointer: `/claims/${index}`,
  claimId: (a.claims[index] as Record<string, Json>)['id'] as string });
/** A paid assessment over the claim attempts. `close` adds the applied closed sufficiency of the plan question's own
 * criterion and depth standing on the accepted claims; without it the acceptance is material only. */
async function assess(f: Paid, planQuestionId: string, claimed: Claimed[], accept: boolean, close = false) {
  const packet = projectAttemptPacket(f.store, { project: f.project, planAnswer: f.v.planAnswer, planQuestionId,
    entries: claimed.map(item => ({ attempt: item.attempt, binding: item.binding })) });
  const rows = claimed.flatMap(item => item.claims.map((_, index) => addressOf(f, item, index)));
  const reply = { verdict: 'supported', reasons: ['Paid assessment'], return: null,
    novelty: {
      attempts: claimed.map(item => ({ attempt: item.attempt, reason: 'Exact result' })),
      accepted: accept ? rows.map(claim => ({ claim, reason: 'Covers the chosen variant' })) : [],
      rejected: accept ? [] : rows.map(claim => ({ claim, reason: 'Rejected by the assessor' })),
      newContent: accept ? rows.map(claim => ({ claim, reason: 'New variant ground' })) : [],
      duplicates: [],
      noProgress: accept ? [] : claimed.map(item => ({ attempt: item.attempt, reason: 'No acknowledged basis' })),
      transition: close && accept ? { outcome: 'closed', bases: rows.map(claim => ({ claim })),
        reason: 'The plan question is answered for the chosen variant',
        sufficiency: { criterion: `Named basis answering ${planQuestionId}`, requiredDepth: 'deep', reason: 'Enough for the required depth',
          methodologyRequirements: [] } } : null },
    methodology: close && accept
      ? { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v2', facts: [] }
      : { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
  // A closed sufficiency runs through the v3 requirements producer; an open verdict keeps the v1 policy producer.
  return close && accept
    ? await assessAttemptsWithRequirements(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root)
    : await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
}

test('5.1: an accepted claim is material; the cell closes only on the proven applied sufficiency of its own depth and criterion', async t => {
  const f = await paid(t), [member] = f.set.value.members;
  const claimed = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [claimed], true)));
  let report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  let industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, false, 'acceptance without a sufficiency decision is material, not coverage');
  assert.equal(industry.grounds.length, 1, 'the ground stays listed as material');
  assert.equal(industry.missing!.code, 'coverage_no_sufficiency');
  assert.equal(report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-market')!.missing!.code,
    'coverage_no_applied_grounds');
  // A lawful closing of the plan's own criterion and depth whose bases stand on the OTHER member's ground: this cell
  // keeps its applied grounds as material with the addressed insufficiency — a foreign member's closure closes nothing
  // here (the door cannot refuse it: the bases are accepted claims of the packet, the variant scope is the reader's).
  const [, other] = f.set.value.members;
  const stray = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'Scoped to the other member', [other!])]);
  const packet = projectAttemptPacket(f.store, { project: f.project, planAnswer: f.v.planAnswer, planQuestionId: 'q-industry',
    entries: [{ attempt: stray.attempt, binding: stray.binding }] });
  const rows = [addressOf(f, stray, 0)];
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: { verdict: 'supported', reasons: ['Paid assessment'], return: null,
    novelty: { attempts: [{ attempt: stray.attempt, reason: 'Exact result' }], accepted: rows.map(claim => ({ claim, reason: 'Covers' })),
      rejected: [], newContent: rows.map(claim => ({ claim, reason: 'New variant ground' })), duplicates: [], noProgress: [],
      transition: { outcome: 'closed', bases: rows.map(claim => ({ claim })), reason: 'Closed on the other member ground',
        sufficiency: { criterion: 'Named basis answering q-industry', requiredDepth: 'deep', reason: 'Enough for the required depth',
          methodologyRequirements: [] } } },
    methodology: { contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v2', facts: [] } } }));
  const misplaced = await assessAttemptsWithRequirements(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
  applyDiscoveryAssessment(f.store, f.project, reference(misplaced));
  const afterStray = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer)
    .cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(afterStray.covered, false, 'a lawful closing on another member ground closes nothing here');
  assert.equal(afterStray.missing!.code, 'coverage_no_sufficiency');
  assert.equal(afterStray.grounds.length, 1, 'this member material stays listed without the foreign ground');
  // The lawful own-ground closing then closes the cell with its full proven sufficiency.
  const closed = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'A second ground of the same variant', [member!])]);
  const closing = await assess(f, 'q-industry', [closed], true, true);
  applyDiscoveryAssessment(f.store, f.project, reference(closing));
  report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, true, 'the applied closed sufficiency standing on the member ground closes the cell');
  assert.ok(isRefLike(industry.sufficiency!.assessment));
  assert.equal(industry.sufficiency!.transition.outcome, 'closed');
  assert.equal(industry.sufficiency!.transition.sufficiency!.requiredDepth, 'deep');
  assert.equal(industry.sufficiency!.transition.sufficiency!.criterion, 'Named basis answering q-industry');
  assert.equal(industry.grounds.length, 2, 'both applied grounds are the exact provenance');
  assert.match(industry.grounds[0]!.contentKey, /^[0-9a-f]{64}$/);
  const before = history(f.store), accounting = money(f.store), sent = f.wires().length;
  const cold = new Store(f.store.path); t.after(() => cold.close());
  assert.deepEqual(computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer), report);
  assert.deepEqual(computeMissingCoverage(cold, f.project, reference(f.published.scope), f.v.planAnswer), report);
  assert.deepEqual(history(f.store), before); assert.deepEqual(money(f.store), accounting); assert.equal(f.wires().length, sent);
});

test('5.1: common material and a foreign member never close the cell even under a closed sufficiency', async t => {
  const f = await paid(t), [, other] = f.set.value.members;
  const common = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'Common market material', 'common')]);
  const foreign = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'Scoped to the other member, however titled', [other!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [common, foreign], true, true)));
  const report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  const industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, false, 'a closed sufficiency on common and a foreign member closes nothing here');
  assert.equal(industry.missing!.code, 'coverage_no_variant_ground');
  assert.equal(industry.common.length, 1, 'the common material stays listed with its provenance');
  assert.equal(industry.grounds.length, 0);
  assert.equal(industry.sufficiency, null);
});

test('5.1: a merely paid but unapplied closing, a rejected claim and a structural lookalike give no coverage; applying completes the chain', async t => {
  const f = await paid(t), [member] = f.set.value.members;
  const claimed = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  const closing = await assess(f, 'q-industry', [claimed], true, true);
  let report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  let industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, false, 'a paid but unapplied closing covers nothing yet');
  assert.equal(industry.missing!.code, 'coverage_no_applied_grounds');
  applyDiscoveryAssessment(f.store, f.project, reference(closing));
  report = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  industry = report.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, true, 'applying the paid closing completes the proven chain');
  const rejected = await claimAttempt(f, 'q-market', [hypothesisClaim(f, 'q-market', 'A rejected ground', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-market', [rejected], false)));
  const market = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer)
    .cells.find(cell => cell.cell.subject.planQuestionId === 'q-market')!;
  assert.equal(market.covered, false, 'a rejected claim covers nothing');
  assert.equal(market.missing!.code, 'coverage_no_applied_grounds');
  // An explicit negative LAST: a forged next progress-state head of q-industry claims the question closed with an
  // application that never existed. The computation walks only proven applied states — the structural lookalike is a
  // typed refusal of the whole projection, never a coverage, a fallback or a silent skip (the lawful cold answer is
  // test 5's subject).
  const stateId = v7ProgressStateId({ project: f.project, planAnswer: f.v.planAnswer, planQuestionId: 'q-industry' });
  const head = f.store.get(stateId);
  f.store.write({ id: stateId, kind: 'v7-progress-state', expected: head ? head.revision : 0,
    value: { contract: 'v7-progress-state/v1', subject: { project: f.project, planAnswer: asJson(f.v.planAnswer), planQuestionId: 'q-industry' },
      application: { id: 'forged', revision: 1, hash: '0'.repeat(64) },
      summary: { cursor: null, count: 99, streak: 9, outcome: 'closed', reason: 'Forged closed summary', nextAction: null } } as never });
  refuses(() => computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer),
    'discovery_progress_conflict');
});

test('5.1: another plan edition keeps the old projection and starts the new cells empty; the same planQuestionId proves nothing', async t => {
  const f = await paid(t), [member] = f.set.value.members;
  const claimed = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [claimed], true, true)));
  const first = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  assert.equal(first.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!.covered, true);
  // The next lawful plan edition: the plan question reopens and is accepted again with the same questions.
  const plan = questionOf(f.store, f.store.get<DiscoveryDraft>(f.v.draft.id)!, 'plan');
  f.discovery.reopen(plan.id, plan.revision);
  const reopened = f.store.get<Question>(plan.id)!;
  const source = f.discovery.evidence.document(f.project, `basis-edition-${rand()}`, 'Exact source for the next edition', 'text/plain', 0);
  answerDiscoveryFixture(f.engine, f.project, f.store.get<DiscoveryDraft>(f.v.draft.id)!, reopened,
    validPlan(f.v.frameRef, [{ id: 'q-industry', axis: 'industry', domain: 'construction', text: 'What covers q-industry?',
      class: 'blocking', criterion: 'Named basis answering q-industry', requiredDepth: 'deep', roles: ['domain expert'], searchPlaces: ['domain documents'] },
    { id: 'q-market', axis: 'market', domain: 'construction', text: 'What covers q-market?',
      class: 'supporting', criterion: 'Named basis answering q-market', requiredDepth: 'deep', roles: ['domain expert'], searchPlaces: ['domain documents'] }], 2, f.v.planAnswer), source);
  const secondAnswer = f.store.get<Question>(plan.id)!.value.answer!;
  assert.notDeepEqual(secondAnswer, f.v.planAnswer);
  assert.deepEqual(computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer), first,
    'the historical projection keeps its own edition');
  const edition = computeMissingCoverage(f.store, f.project, reference(f.published.scope), secondAnswer);
  const industry = edition.cells.find(cell => cell.cell.subject.planQuestionId === 'q-industry')!;
  assert.equal(industry.covered, false, 'the applied grounds and closing served the previous edition only');
  assert.equal(industry.missing!.code, 'coverage_no_applied_grounds');
  // Another depth or criterion is another cell address — the pure key of the closed form says so directly.
  assert.notEqual(coverageCellKey({ ...industry.cell, requiredDepth: 'exhaustive' }), industry.key, 'another depth is another cell');
  assert.notEqual(coverageCellKey({ ...industry.cell, criterion: 'Another named basis' }), industry.key,
    'another criterion is another cell');
});

test('5.1: later heads never rewrite the old projection — a revise, a mode move and a restart keep the covered answer', async t => {
  const f = await paid(t), [member] = f.set.value.members;
  const claimed = await claimAttempt(f, 'q-industry', [hypothesisClaim(f, 'q-industry', 'The chosen variant bounds the industry risk', [member!])]);
  applyDiscoveryAssessment(f.store, f.project, reference(await assess(f, 'q-industry', [claimed], true, true)));
  const original = computeMissingCoverage(f.store, f.project, reference(f.published.scope), f.v.planAnswer);
  const rejection: VariantChoiceScope = { ...f.scope, operation: 'revise', previous: reference(f.act.decision),
    expectedSelection: reference(f.act.state), outcome: { kind: 'reject_all', reason: 'Owner rejects this exact set' } };
  answerVariantChoice(f.store, rejection, mintOf(f.store, rejection).authority);
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

const mintOf = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const exchanged = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...exchanged, authority: sessions.authority(exchanged.bearer)! };
};
