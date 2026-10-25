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
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession, type VariantSessionInput } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, variantRecordId,
  type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_DECISION_CONTRACT, VARIANT_OWNER_ACTION,
  type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { claimContentKey, normalizeClaimText } from '../src/discovery/v7-attempt-assessment.js';
import type { ClaimAddress, ResolvedClaim } from '../src/discovery/claim-address.js';
import type { V7AttemptEnd } from '../src/discovery/v7-plan-questions.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { managedTurnId, projectPaidTurnAdmission } from '../src/discovery/research-consumer-transition.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import type { OmResult } from '../src/om/refusal.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

// 4P.2 (codex-omg2 №12112, the DR4 decision 6): the content key of an owner-decision claim over a variant owner act —
// the act form, project/draft, exact set, choose/member or reject_all and the normalized reason, proven only through
// readVariantOwnerDecision with its decision/state pair. Grant/session, times, calls, CAS, the previous chain and the
// operation are service: a new lawful act of the same choice keeps the key. The v2 condition branch keeps its keys.
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

/** The real paid variant line of 4P.1 (two assessed questions, snapshot, real modes, the paid two-member set) plus the
 * v7 claim container: a v7 plan chain and managed attempts of one research run in the same store and project. */
async function paid(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-4p2-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Variant owner act content key' });
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
  const calibration = f.store.write({ id: 'transport-fixture:4p2-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
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
  return { ...g, project, saved, questions, reply, set, draft, state1, scope };
}
type Paid = Awaited<ReturnType<typeof paid>>;

const mint = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const exchanged = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...exchanged, authority: sessions.authority(exchanged.bearer)! };
};
const revised = (scope: VariantChoiceScope, act: ReturnType<typeof answerVariantChoice>, kind: 'choose' | 'reject_all'): VariantChoiceScope => ({
  ...scope, operation: 'revise', previous: reference(act.decision), expectedSelection: reference(act.state),
  outcome: kind === 'choose' ? { kind, member: scope.outcome.kind === 'choose' ? scope.outcome.member : scope.set, reason: 'Owner revised the exact choice' }
    : { kind, reason: 'Owner rejects this exact set' } });
/** A real paid bypass model decision over the current set of the same outcome shape. */
async function modelChoose(f: Paid, outcome: 'choose' | 'reject_all' = 'choose') {
  const previous = f.store.get('project-mode:p'), modeScope = { project: 'p', mode: 'bypass' as const, previous: previous ? reference(previous) : null };
  const sessions = new ProjectModeSessions(f.store), issued = ok(issueProjectModeInvitation(f.store, modeScope));
  const login = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  const mode = setProjectMode(f.store, modeScope, sessions.authority(login.bearer)).record;
  f.reply(outcome === 'choose' ? { action: 'choose', key: 'v1', reason: 'Real paid model choice' } : { action: 'reject_all', reason: 'Real paid model rejection' });
  const calibration = reference(f.store.write({ id: `transport-fixture:4p2-model-${rand()}`, kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT,
      kind: 'decision', set: calibration, mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
  const input: VariantSessionInput = { projectId: 'p', environment: f.environment, role: f.environment.value.implementer, prompt: 'Choose from the exact paid set',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: reference(f.set), mode: reference(mode), expectedSelection: reference(f.store.get(variantStateId('p', f.scope.draft.id))!) } };
  await runVariantSession(f.store, input);
  return f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === 'p')!;
}

/* ---------- the v7 claim container: the paid line's own single draft, a separate research run ---------- */

/** The attempt door singles out the one v7 draft of the project, so the claims ride the paid line's own draft and plan
 * answer, in their own research run — never a second v7 draft. */
function claimsLine(f: Paid) {
  return { draft: f.store.get<DiscoveryDraft>(f.v.draft.id)!, plan: f.store.get<Question>(f.v.plan.id)!,
    planAnswer: f.v.planAnswer, runId: `research-run:${f.project}:${rand()}` };
}
type ClaimsProject = ReturnType<typeof claimsLine>;
const planLink = (v: ClaimsProject, planQuestionId: string) => [{ planAnswer: asJson(v.planAnswer), planQuestionId }];
function ownerClaim(v: ClaimsProject, authority: Ref, text = 'The owner chose the exact variant'): Json {
  return { id: `own-${rand()}`, kind: 'owner-decision', text, axis: 'market', planQuestions: planLink(v, 'q-industry'),
    scope: { variants: 'common' }, basis: { authority: asJson(authority) } } as unknown as Json;
}
const submitted = (...claims: Json[]): V7AttemptEnd => ({ type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } });
const writeRef = (write: Write): Ref => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) });
/** One turn of a research run in the producers' saved form, as the assessment fixture numbers them. */
function managedTurn(f: Paid, v: ClaimsProject, planQuestionId: string, end: V7AttemptEnd) {
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
type Attempt = { attempt: Ref; end: V7AttemptEnd };
function attempt(f: Paid, v: ClaimsProject, end: V7AttemptEnd): Attempt {
  const chain = managedTurn(f, v, 'q-industry', end);
  const recorded = recordV7Attempt(f.store, { project: f.project, planAnswer: v.planAnswer, planQuestionId: 'q-industry',
    call: reference(chain.call as Revision<unknown>), end }).attempt;
  completeResearchAttemptTurn(f.store, f.project, reference(chain.turn), reference(recorded));
  return { attempt: exact(recorded), end };
}
const address = (f: Paid, _v: ClaimsProject, a: Attempt, index: number): ClaimAddress => ({ project: f.project, container: a.attempt,
  containerKind: 'research-attempt', pointer: `/claims/${index}`,
  claimId: ((a.end as { value: { claims: Json[] } }).value.claims[index] as Record<string, Json>)['id'] as string });

test('4P.2: the owner act keys the claim by its content — a newer lawful act of the same choice keeps the key through the public claimContentKey', async t => {
  const f = await paid(t), v = claimsLine(f), m = mint(f.store, f.scope);
  const initial = answerVariantChoice(f.store, f.scope, m.authority);
  const revise = { ...revised(f.scope, initial, 'choose'),
    outcome: { kind: 'choose' as const, member: f.set.value.members[0]!, reason: f.scope.outcome.kind === 'choose' ? f.scope.outcome.reason : '' } };
  const newer = answerVariantChoice(f.store, revise, mint(f.store, revise).authority);
  const a = attempt(f, v, submitted(ownerClaim(v, reference(initial.decision)), ownerClaim(v, reference(newer.decision))));
  const key = (index: number) => claimContentKey(f.store, address(f, v, a, index));
  const before = history(f.store), accounting = money(f.store), sent = f.wires().length;
  assert.equal(key(0), key(1), 'a new session, previous link and operation of the same choice is the same content');
  assert.equal(key(0), key(0), 'the cold exact repeat is stable');
  const cold = new Store(f.store.path); t.after(() => cold.close());
  assert.equal(claimContentKey(cold, address(f, v, a, 0)), key(0), 'the key survives a restart without rewrites');
  assert.deepEqual(history(f.store), before, 'the key computation writes nothing');
  assert.deepEqual(money(f.store), accounting, 'and pays nothing');
  assert.equal(f.wires().length, sent);
});

test('4P.2: another member, set or substantive reason is another content; reject_all is a real owner act with its own key', async t => {
  const f = await paid(t), v = claimsLine(f), m = mint(f.store, f.scope);
  const first = answerVariantChoice(f.store, f.scope, m.authority);
  const other: VariantChoiceScope = { ...revised(f.scope, first, 'choose'),
    outcome: { kind: 'choose', member: f.set.value.members[1]!, reason: 'The second member fits better' } };
  const second = answerVariantChoice(f.store, other, mint(f.store, other).authority);
  const rejection = revised(f.scope, second, 'reject_all');
  const last = answerVariantChoice(f.store, rejection, mint(f.store, rejection).authority);
  const a = attempt(f, v, submitted(ownerClaim(v, reference(first.decision)), ownerClaim(v, reference(second.decision)),
    ownerClaim(v, reference(last.decision)), ownerClaim(v, reference(first.decision), 'Another claim wording')));
  const key = (index: number) => claimContentKey(f.store, address(f, v, a, index));
  const keys = new Set([key(0), key(1), key(2)]);
  assert.equal(keys.size, 3, 'member, reason and reject_all are distinct contents');
  assert.notEqual(key(3), key(0), 'the claim text stays part of the key');
  const g = await paid(t), gv = claimsLine(g), gm = mint(g.store, g.scope);
  const gact = answerVariantChoice(g.store, g.scope, gm.authority);
  const ga = attempt(g, gv, submitted(ownerClaim(gv, reference(gact.decision))));
  assert.notEqual(claimContentKey(g.store, address(g, gv, ga, 0)), key(0), 'another exact set/draft is another content');
});

test('4P.2: the act reason is normalized by the accepted text rule — service wording changes keep the key', async t => {
  assert.equal(normalizeClaimText('  The owner chose\r\nthe exact set  '), 'The owner chose\nthe exact set');
  const f = await paid(t), v = claimsLine(f);
  const clean: VariantChoiceScope = { ...f.scope, outcome: { kind: 'choose', member: f.set.value.members[0]!, reason: 'The owner chose\nthe exact set' } };
  const first = answerVariantChoice(f.store, clean, mint(f.store, clean).authority);
  const padded: VariantChoiceScope = { ...revised(f.scope, { decision: first.decision, state: first.state } as ReturnType<typeof answerVariantChoice>, 'choose'),
    outcome: { kind: 'choose', member: f.set.value.members[0]!, reason: '  The owner chose\r\nthe exact set  ' } };
  const second = answerVariantChoice(f.store, padded, mint(f.store, padded).authority);
  const a = attempt(f, v, submitted(ownerClaim(v, reference(first.decision)), ownerClaim(v, reference(second.decision))));
  assert.equal(claimContentKey(f.store, address(f, v, a, 0)), claimContentKey(f.store, address(f, v, a, 1)),
    'outer whitespace and CRLF of the act reason are not content');
});

test('4P.2: a paid model decision, a grant or session, a structural lookalike, a hidden basis, a foreign project and a damaged Ref never key an owner act', async t => {
  const f = await paid(t), v = claimsLine(f);
  // The bypass model decision first (the set is decided once); the owner then overrides it — a real owner act.
  const model = await modelChoose(f);
  const override: VariantChoiceScope = { ...f.scope, operation: 'override', previous: reference(model),
    mode: reference(f.store.get('project-mode:p')!),
    expectedSelection: reference(f.store.get<VariantState>(variantStateId('p', f.scope.draft.id))!),
    outcome: { kind: 'choose', member: f.set.value.members[0]!, reason: 'Owner overrides the model choice' } };
  const m = mint(f.store, override);
  const act = answerVariantChoice(f.store, override, m.authority);
  const invented: Ref = { id: `discovery-choice-session:${rand()}`, revision: 1, hash: '0'.repeat(64) };
  const fake = { contract: VARIANT_OWNER_DECISION_CONTRACT, projectId: 'p', draft: f.scope.draft, set: reference(f.set), mode: f.scope.mode,
    expectedSelection: reference(f.state1), previous: null, operation: 'initial',
    outcome: { kind: 'choose', member: f.set.value.members[0], reason: 'A lookalike with no real session' },
    authority: { grant: invented, session: invented } };
  const lookalike = reference(f.store.write({ id: variantRecordId('discovery-variant-owner-decision', fake),
    kind: 'discovery-variant-owner-decision', expected: 0, value: fake }));
  const a = attempt(f, v, submitted(ownerClaim(v, reference(act.decision)), ownerClaim(v, reference(model)),
    ownerClaim(v, lookalike)));
  // A grant or a v4 session is not an act at all: the attempt door refuses to even record such a claim basis (their
  // v4 form carries no top-level project) — asserted first, its turn machinery writes before the door refuses.
  refuses(() => attempt(f, v, submitted(ownerClaim(v, m.issued.grant))), 'attempt_invalid');
  const key = (index: number) => claimContentKey(f.store, address(f, v, a, index));
  const before = history(f.store), accounting = money(f.store);
  assert.ok(key(0), 'the real act keys its claim');
  for (const index of [1, 2])
    refuses(() => key(index), 'discovery_novelty_invalid');
  // A hidden proof basis (the state of the real act) never proves the act.
  const hidden = reference(act.state), get = f.store.get.bind(f.store);
  f.store.get = ((id: string, revision?: number) => id === hidden.id && revision === hidden.revision ? null : get(id, revision)) as typeof f.store.get;
  refuses(() => key(0), 'discovery_novelty_invalid');
  f.store.get = get;
  // The key refuses the grant, the session, a damaged hash or revision and a foreign act record the same typed way
  // through the standard resolver seam — a negative harness: the claim JSON is the real form, its basis Refs are the
  // real saved records.
  const resolve = (authority: Ref) => (item: ClaimAddress) => ({ container: undefined as never,
    claim: { id: item.claimId, kind: 'owner-decision', text: 'The owner chose the exact variant',
      basis: { authority: asJson(authority) } } as unknown as Json }) as unknown as ResolvedClaim;
  const at0 = address(f, v, a, 0);
  for (const authority of [m.issued.grant, m.session, { ...reference(act.decision), hash: '0'.repeat(64) },
    { ...reference(act.decision), revision: 9 }, { id: `discovery-variant-owner-decision:foreign:${rand()}`, revision: 1, hash: '0'.repeat(64) }])
    refuses(() => claimContentKey(f.store, at0, { resolve: resolve(authority as Ref) }), 'discovery_novelty_invalid');
  assert.deepEqual(history(f.store), before, 'the refusals write nothing');
  assert.deepEqual(money(f.store), accounting, 'and pay nothing');
});

test('4P.2: the key of a former lawful act survives later choices, a mode change, a session revoke and a restart', async t => {
  const f = await paid(t), v = claimsLine(f), m = mint(f.store, f.scope);
  const first = answerVariantChoice(f.store, f.scope, m.authority);
  const a = attempt(f, v, submitted(ownerClaim(v, reference(first.decision))));
  const key = () => claimContentKey(f.store, address(f, v, a, 0));
  const original = key();
  const rejection = revised(f.scope, first, 'reject_all');
  answerVariantChoice(f.store, rejection, mint(f.store, rejection).authority);
  ok(m.sessions.revoke(m.bearer));
  const previous = f.store.get('project-mode:p');
  const modeScope = { project: 'p', mode: 'bypass' as const, previous: previous ? reference(previous) : null };
  const sessions = new ProjectModeSessions(f.store), issued = ok(issueProjectModeInvitation(f.store, modeScope));
  const login = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  setProjectMode(f.store, modeScope, sessions.authority(login.bearer));
  const cold = new Store(f.store.path); t.after(() => cold.close());
  assert.equal(key(), original, 'the historical key stays the same in place');
  assert.equal(claimContentKey(cold, address(f, v, a, 0)), original, 'and after a restart');
  const accounting = money(f.store), sent = f.wires().length;
  assert.deepEqual(money(f.store), accounting); assert.equal(f.wires().length, sent);
});
