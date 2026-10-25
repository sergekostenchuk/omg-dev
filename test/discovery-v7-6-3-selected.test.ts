import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { Discovery } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import type { ResearchAnswer, ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession, type VariantSessionInput } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION, type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';
import { DISCOVERY_DEEP_PREPARATION_CONTRACT, produceDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT, computeMissingCoverage, computeMissingCoverageAt } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { runDeepResearch, applyDeepResearch } from '../src/discovery/deep-research-execution.js';
import { V7_AXES, DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { produceSelectedDossier, readSelectedDossier, SELECTED_DOSSIER_KIND,
  selectedDossierId, decodeSelectedDossier, type SelectedDossier } from '../src/discovery/selected-dossier.js';
import { DOSSIER_MANIFEST_KIND } from '../src/discovery/dossier-manifest.js';

// Real paid generation/selection preparation shared in shape with the accepted 4P.1 scenarios.
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
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


/** The real paid line of 4B.1/4O.2: two assessed plan questions, the variant snapshot, real project modes and the real
 * paid generation of a two-member set with its first state. */
async function paid(t: test.TestContext, answer: unknown = generation()) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-5-5-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Selected variant scope' });
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
  // Transport-only service calibration; the positive producer below uses the real snapshot.
  const calibration = f.store.write({ id: 'transport-fixture:scope-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: project } });
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer]) {
    reply(generation());
    await researchCall(role, f.environment.value, 'Calibrate generation', { variantSubject: { ...subject, snapshot: reference(calibration) }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  }
  reply(answer);
  await runVariantSession(f.store, { projectId: project, environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Propose variants from this exact paid sweep', variantSubject: subject });
  const found = f.store.list<VariantSet>('discovery-variant-set').find(row => row.value.projectId === project) ?? null;
  if (!found) {
    const noneDraft = reference(f.store.get<DiscoveryDraft>(f.v.draft.id)!);
    return { ...g, project, saved, questions, reply, set: null, draft: noneDraft,
      state1: f.store.get<VariantState>(variantStateId(project, noneDraft.id))!, scope: null };
  }
  const set = found, draft = set.value.draft, state1 = f.store.get<VariantState>(variantStateId(project, draft.id))!;
  const scope: VariantChoiceScope = { action: VARIANT_OWNER_ACTION, projectId: project, draft, set: reference(set), mode: reference(questions),
    operation: 'initial', previous: null, expectedSelection: reference(state1), outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'The exact paid set fits the owner goal' } };
  return { ...g, project, saved, questions, reply, set, draft, state1, scope };
}

const mint = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const exchanged = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...exchanged, authority: sessions.authority(exchanged.bearer)! };
};
const modeOf = (store: Store, mode: 'questions' | 'bypass') => {
  const previous = store.get('project-mode:p'), scope = { project: 'p', mode, previous: previous ? reference(previous) : null };
  const sessions = new ProjectModeSessions(store), issued = ok(issueProjectModeInvitation(store, scope));
  const login = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  return setProjectMode(store, scope, sessions.authority(login.bearer)).record;
};
/** The real paid bypass model decision over the current set, choose or reject_all. */
async function modelChoose(f: Awaited<ReturnType<typeof paid>>, outcome: 'choose' | 'reject_all' = 'choose') {
  const mode = modeOf(f.store, 'bypass');
  f.reply(outcome === 'choose' ? { action: 'choose', key: 'v1', reason: 'Real paid model choice' } : { action: 'reject_all', reason: 'Real paid model rejection' });
  const calibration = reference(f.store.write({ id: 'transport-fixture:scope-decision-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT,
      kind: 'decision', set: calibration, mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
  const input: VariantSessionInput = { projectId: 'p', environment: f.environment, role: f.environment.value.implementer, prompt: 'Choose from the exact paid set',
    variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision', set: reference(f.set!), mode: reference(mode), expectedSelection: reference(f.store.get(variantStateId('p', f.scope!.draft.id))!) } };
  await runVariantSession(f.store, input);
  return f.store.list<VariantModelDecision>('discovery-variant-model-decision').find(row => row.value.projectId === 'p')!;
}

type Paid = Awaited<ReturnType<typeof paid>>;
function selected(f: Paid) {
  const act = answerVariantChoice(f.store, f.scope!, mint(f.store, f.scope!).authority);
  return { act, published: publishVariantScope(f.store, 'p', reference(act.decision)).scope };
}
function inputFor(f: Paid, scope: ReturnType<typeof publishVariantScope>['scope'], questionId = 'q-industry'): DeepPreparation {
  const question = provePlanQuestions(f.store, f.store.get<DiscoveryDraft>(scope.value.draft.id, scope.value.draft.revision)!,
    f.v.planAnswer).find(item => item.planQuestionId === questionId)!.question as Record<string, Json>;
  return { contract: DISCOVERY_DEEP_PREPARATION_CONTRACT, cell: { contract: DISCOVERY_COVERAGE_CELL_CONTRACT,
    projectId: 'p', subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: f.v.planAnswer, planQuestionId: questionId },
    variant: { set: scope.value.set, member: scope.value.member }, requiredDepth: question.requiredDepth as string,
    criterion: question.criterion as string }, scope: reference(scope) };
}
function nextPlan(f: Paid, store: Store) {
  const engine = new ProductEngine(store), discovery = new Discovery(store), plan = store.get<Question>(f.v.plan.id)!;
  discovery.reopen(plan.id, plan.revision);
  const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(f.v.draft.id)!;
  const source = discovery.evidence.document('p', 'deep-next-plan', 'Next accepted plan', 'text/plain', 0);
  const questions = provePlanQuestions(store, f.v.draft, f.v.planAnswer).map(item => item.question as unknown as PlanQuestion);
  answerDiscoveryFixture(engine, 'p', draft, question, validPlan(f.v.frameRef, questions, 2, f.v.planAnswer), source);
  return store.get<Question>(plan.id)!.value.answer!;
}


const all = (store: Store) => {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
    revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id,revision').all() } as never); }
  finally { db.close(); }
};
function unchanged(f: Paid, store: Store, action: () => unknown, refuses = false) {
  const before = all(store), calls = money(store), wires = f.wires();
  let result: unknown;
  if (refuses) assert.throws(action, error => error instanceof EngineError);
  else result = action();
  assert.equal(all(store), before); assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  return result;
}
async function setup(t: test.TestContext, model = false) {
  const f = await paid(t);
  const decision = model ? await modelChoose(f) : selected(f).act.decision;
  const scope = publishVariantScope(f.store, 'p', reference(decision)).scope;
  return { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
}
type Selected = Awaited<ReturnType<typeof setup>>;
function claim(f: Selected, question: string, axis: string, text: string, variants: 'common' | Ref[] = [f.scopeRecord.value.member]): Json {
  return { id: `h-${rand()}`, kind: 'hypothesis', text, axis,
    planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants },
    basis: { howToVerify: 'Observe the named exact variant' } } as unknown as Json;
}
async function deep(f: Selected, question: string, claims: Json[]) {
  const preparation = produceDeepPreparation(f.store, 'p', inputFor(f, f.scopeRecord, question)).record;
  const subject = { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: question };
  const baseline = v7ProgressBaseline(f.store, subject), state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  const owner = f.store.get<ResearchRun>(state.value.summary.cursor.run)!;
  f.reply({ action: 'answer', question, value: { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } }, citations: [] });
  const result = (await runDeepResearch(f.store, { projectId: 'p', deepPreparation: reference(preparation),
    environment: f.environment, owner: reference(owner) }))!;
  assert.ok(result.attempt); return { result, claims, question, preparation };
}
type Entry = Awaited<ReturnType<typeof deep>>;
const addresses = (entry: Entry): ClaimAddress[] => entry.claims.map((row: any, index) => ({ project: 'p', container: reference(entry.result.attempt),
  containerKind: 'research-attempt', pointer: `/claims/${index}`, claimId: row.id }));
async function assess(f: Selected, entry: Entry, outcome: 'closed' | 'open' | 'unknown' | 'rejected' | 'material' = 'closed', apply = true) {
  const packet = projectAttemptPacket(f.store, { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: entry.question,
    entries: [{ attempt: reference(entry.result.attempt), binding: reference(entry.result.binding) }] });
  const rows = addresses(entry), accepted = outcome !== 'rejected';
  const transition = outcome === 'closed' ? { outcome, bases: rows.map(claim => ({ claim })), reason: 'Exact cell answered',
    sufficiency: { criterion: `Named basis answering ${entry.question}`, requiredDepth: 'deep', reason: 'Enough exact grounds', methodologyRequirements: [] } }
    : ['open', 'unknown'].includes(outcome) ? { outcome, bases: rows.map(claim => ({ claim })), reason: 'Reopened on new evidence',
      ...(outcome === 'unknown' ? { consequence: 'Await exact evidence', nextAction: 'Obtain the source' } : {}) } : null;
  f.reply({ verdict: 'supported', reasons: ['Real paid classification'], return: null,
    novelty: { attempts: [{ attempt: reference(entry.result.attempt), reason: 'Exact managed deep' }],
      accepted: accepted ? rows.map(claim => ({ claim, reason: 'Own variant material' })) : [],
      rejected: accepted ? [] : rows.map(claim => ({ claim, reason: 'Rejected material retained' })),
      newContent: accepted ? rows.map(claim => ({ claim, reason: 'New exact content' })) : [], duplicates: [],
      noProgress: accepted ? [] : [{ attempt: reference(entry.result.attempt), reason: 'No new accepted material' }], transition },
    methodology: { contract: 'assessment-methodology/v1', policy: outcome === 'closed' ? 'assessment-methodology-policy/v2' : 'assessment-methodology-policy/v1', facts: [] } });
  const mr = outcome === 'closed' ? await assessAttemptsWithRequirements(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root)
    : await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
  if (apply) applyDiscoveryAssessment(f.store, 'p', reference(mr));
  return mr;
}
async function complete(f: Selected) {
  const industry = await deep(f, 'q-industry', V7_AXES.map(axis => claim(f, 'q-industry', axis, `Exact ${axis} evidence`)));
  await assess(f, industry);
  const market = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Market cell evidence')]);
  await assess(f, market);
  return { industry, market };
}
function revise(f: Selected, store = f.store) {
  const state = store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const scope: VariantChoiceScope = { ...f.scope!, mode: reference(store.get('project-mode:p')!), operation: store.get(state.value.decision!.id)!.kind === 'discovery-variant-model-decision' ? 'override' : 'revise',
    previous: state.value.decision!, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'Owner changes chosen member' } };
  return answerVariantChoice(store, scope, mint(store, scope).authority);
}

for (const model of [false, true]) test(`6.3 selected: real ${model ? 'model' : 'owner'} choose → two managed deep cells → applied sufficiency → immutable cold snapshot`, async t => {
  const f = await setup(t, model); await complete(f);
  const moneyBefore = money(f.store), wires = f.wires();
  const first = produceSelectedDossier(f.store, 'p', f.input);
  assert.equal(first.verification, 'complete'); assert.equal(first.repeated, false);
  assert.equal(first.manifest.value.completeness, 'complete'); assert.deepEqual(first.manifest.value.reasons, []);
  assert.equal(first.coverage.cells.length, 2); assert.equal(first.coverage.missing.length, 0);
  for (const axis of V7_AXES) assert.ok(first.manifest.value.axes[axis].claims.length);
  assert.deepEqual(money(f.store), moneyBefore); assert.deepEqual(f.wires(), wires);
  const cold = new Store(f.store.path); t.after(() => cold.close());
  for (const store of [cold, f.store]) {
    unchanged(f, store, () => assert.deepEqual(produceSelectedDossier(store, 'p', f.input), { ...first, repeated: true }));
    unchanged(f, store, () => assert.deepEqual(readSelectedDossier(store, 'p', reference(first.record)), (({ repeated: _, ...rest }) => rest)(first)));
  }
  revise(f);
  modeOf(f.store, model ? 'questions' : 'bypass');
  nextPlan(f, f.store);
  const frameAnswer = f.store.get<ResearchAnswer>(first.record.value.frame.id, first.record.value.frame.revision)!;
  const frameQuestion = f.store.get<Question>(frameAnswer.value.question)!;
  f.store.write({ id: frameQuestion.id, kind: frameQuestion.kind, expected: frameQuestion.revision,
    value: { ...frameQuestion.value, projectId: 'foreign-project', draftId: 'foreign-draft' } });
  for (const store of [f.store, cold]) unchanged(f, store, () => {
    const historical = readSelectedDossier(store, 'p', reference(first.record));
    assert.deepEqual(historical.record, first.record); assert.deepEqual(historical.manifest, first.manifest);
    assert.deepEqual(produceSelectedDossier(store, 'p', reference(first.record)), { ...first, repeated: true });
  });
});

for (const cold of [false, true])
test(`6.3 selected: ${cold ? 'cold' : 'hot'} foreign frame Question head cannot publish either half of a new snapshot`, async t => {
  const f = await setup(t); await complete(f);
  const frameAnswer = f.store.get<ResearchAnswer>(f.v.frameRef.id, f.v.frameRef.revision)!;
  const original = f.store.get<Question>(frameAnswer.value.question)!;
  assert.ok(f.store.get<DiscoveryDraft>(f.draft.id)!.value.questions.includes(original.id));
  const acceptedHistory = f.store.history(original.id);
  for (const field of ['projectId', 'draftId'] as const) {
    const previous = f.store.get<Question>(original.id)!;
    const foreign = f.store.write({ id: original.id, kind: original.kind, expected: previous.revision,
      value: { ...original.value, [field]: `foreign-${field}` } });
    assert.equal(foreign.hash, hashJson(foreign.value));
    assert.deepEqual(f.store.history(original.id).slice(0, acceptedHistory.length), acceptedHistory);
    const store = cold ? new Store(f.store.path) : f.store;
    try {
      unchanged(f, store, () => assert.throws(() => produceSelectedDossier(store, 'p', f.input),
        error => error instanceof EngineError && error.code === 'discovery_selected_dossier_stale'
          && (error.details as { field?: string } | null)?.field === 'frame'));
      assert.equal(store.list(SELECTED_DOSSIER_KIND).length, 0);
      assert.equal(store.list(DOSSIER_MANIFEST_KIND).length, 0);
    } finally { if (cold) store.close(); }
  }
});

test('6.3 selected: missing cell, merely paid MR, common/foreign grounds, material-only and reopened sufficiency never imply completeness', async t => {
  const f = await setup(t), original = await deep(f, 'q-industry', V7_AXES.map(axis => claim(f, 'q-industry', axis, `Required ${axis}`)));
  await assess(f, original); unchanged(f, f.store, () => produceSelectedDossier(f.store, 'p', f.input), true);
  const common = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Common market closure', 'common')]);
  await assess(f, common); unchanged(f, f.store, () => produceSelectedDossier(f.store, 'p', f.input), true);
  const foreign = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Another member closure', [f.set!.value.members[1]!])]);
  await assess(f, foreign); unchanged(f, f.store, () => produceSelectedDossier(f.store, 'p', f.input), true);
  const exactPreparation = inputFor(f, f.scopeRecord, 'q-market');
  unchanged(f, f.store, () => produceDeepPreparation(f.store, 'p', { ...exactPreparation,
    cell: { ...exactPreparation.cell, requiredDepth: 'brief' } }), true);
  const material = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Accepted material with open sufficiency')]);
  await assess(f, material, 'material');
  unchanged(f, f.store, () => produceSelectedDossier(f.store, 'p', f.input), true);
  const own = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Own market basis')]);
  const mr = await assess(f, own, 'closed', false);
  unchanged(f, f.store, () => produceSelectedDossier(f.store, 'p', f.input), true);
  applyDiscoveryAssessment(f.store, 'p', reference(mr));
  const first = produceSelectedDossier(f.store, 'p', f.input);
  const entry = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Later uncertainty')]);
  const lateMR = await assess(f, entry, 'unknown', false);
  // An unapplied late MR belongs to the inventory but cannot change its coverage.
  const second = produceSelectedDossier(f.store, 'p', f.input);
  assert.notEqual(second.record.id, first.record.id);
  applyDiscoveryAssessment(f.store, 'p', reference(lateMR));
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    unchanged(f, store, () => produceSelectedDossier(store, 'p', f.input), true);
    unchanged(f, store, () => {
      assert.deepEqual(readSelectedDossier(store, 'p', reference(first.record)).manifest, first.manifest);
      assert.deepEqual(readSelectedDossier(store, 'p', reference(second.record)).manifest, second.manifest);
      const at = computeMissingCoverageAt(store, 'p', f.input.scope, f.input.plan, first.record.value.boundary.sequence);
      assert.equal(at.missing.length, 0);
      assert.equal(computeMissingCoverage(store, 'p', f.input.scope, f.input.plan).missing.length, 1);
    });
  }
});

test('6.3 selected: rejected/unassessed claims, addressed unknowns and both explicit contradiction/refutation sides survive', async t => {
  const f = await setup(t), entries = await complete(f), target = addresses(entries.industry)[0]!;
  const contrary = { ...(claim(f, 'q-market', 'market', 'Explicit contrary observation') as Record<string, Json>), contradicts: [target], refutedBy: [target] } as unknown as Json;
  const rejected = await deep(f, 'q-market', [contrary]); await assess(f, rejected, 'rejected');
  const unknown = { ...(claim(f, 'q-market', 'market', 'An addressed residual unknown') as Record<string, Json>), kind: 'unknown',
    basis: { origin: 'Named gap', unknownId: 'residual', question: 'Which deployment?', affects: ['deployment'], consumer: 'feasibility',
      blocksCurrentStage: false, moment: 'feasibility', closeCriterion: 'Identify deployment' } } as unknown as Json;
  const waiting = await deep(f, 'q-market', [unknown]);
  const first = produceSelectedDossier(f.store, 'p', f.input);
  assert.ok(first.materials.some(m => m.status === 'rejected' && m.claim.container.id === rejected.result.attempt.id));
  assert.ok(first.materials.some(m => m.status === 'unassessed' && m.claim.container.id === waiting.result.attempt.id));
  assert.equal(first.manifest.value.unknowns[0]!.unknownId, 'residual');
  assert.equal(first.contradictions.length, 2); assert.ok(first.manifest.value.contradictions.some(c => c.blocking && c.resolution.state === 'open'));
  await assess(f, waiting, 'material');
  const cold = new Store(f.store.path); t.after(() => cold.close());
  unchanged(f, cold, () => assert.deepEqual(readSelectedDossier(cold, 'p', reference(first.record)).manifest, first.manifest));
});

test('6.3 selected: closed input, structural complete and exact carrier grounds refuse missing/null/foreign/substituted data hot/cold', async t => {
  const f = await setup(t); await complete(f);
  const first = produceSelectedDossier(f.store, 'p', f.input);
  const sites = referenceSites(SELECTED_DOSSIER_KIND, first.record.value);
  assert.equal(sites.length, 9 + Object.values(first.record.value.inventory).reduce((n, rows) => n + rows.length, 0));
  for (const input of [{}, { plan: f.input.plan }, { scope: null, plan: f.input.plan }, { scope: f.input.scope, plan: null },
    { ...f.input, covered: true }, { scope: { ...f.input.scope, id: f.input.scope.id.replace(':p:', ':other:') }, plan: f.input.plan }])
    unchanged(f, f.store, () => produceSelectedDossier(f.store, 'p', input), true);
  unchanged(f, f.store, () => readSelectedDossier(f.store, 'p', reference(first.manifest)), true);
  for (const field of ['scope', 'plan', 'inventory', 'boundary', 'manifest'] as const) {
    const value = { ...first.record.value }; delete (value as any)[field];
    assert.throws(() => decodeSelectedDossier(value), EngineError);
    assert.throws(() => decodeSelectedDossier({ ...first.record.value, [field]: null }), EngineError);
  }
  const state = first.record.value.inventory.states[0]!, application = first.record.value.inventory.applications[0]!;
  for (const lost of [f.input.scope, state, application, first.record.value.inventory.accounts[0]!, first.record.value.inventory.assessments[0]!]) {
    for (const store of [f.store, new Store(f.store.path)]) {
      if (store !== f.store) t.after(() => store.close());
      const get = store.get;
      store.get = ((id, rev) => id === lost.id ? null : get.call(store, id, rev)) as typeof store.get;
      try { unchanged(f, store, () => readSelectedDossier(store, 'p', reference(first.record)), true); }
      finally { delete (store as any).get; }
    }
  }
  // A fully hashed structural carrier which omits paid/unassessed inventory is still not proof.
  const forged: SelectedDossier = { ...first.record.value, inventory: { ...first.record.value.inventory, assessments: [] } };
  const row = f.store.write({ id: selectedDossierId(forged), kind: SELECTED_DOSSIER_KIND, expected: 0, value: forged });
  unchanged(f, f.store, () => readSelectedDossier(f.store, 'p', reference(row)), true);
});

for (const race of ['mode', 'selection', 'plan', 'frame', 'P', 'material'] as const)
test(`6.3 selected: second Store ${race} in the collection/publication window leaves neither half snapshot`, async t => {
  const f = await setup(t); await complete(f);
  const other = new Store(f.store.path); t.after(() => other.close());
  let pendingMR: Awaited<ReturnType<typeof assess>> | null = null, pendingIntent: Ref | null = null;
  if (race === 'P') {
    const entry = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Concurrent applied evidence')]);
    pendingMR = await assess(f, entry, 'unknown', false);
  }
  if (race === 'material') {
    const writeMany = Store.prototype.writeMany;
    Store.prototype.writeMany = function(this: Store, writes, guards) {
      if (this !== f.store) return writeMany.call(this, writes, guards);
      if (writes.some(w => w.kind === 'research-attempt')) throw new EngineError('selected_material_cut', 'Cut paid result before its atomic application');
      return writeMany.call(this, writes, guards);
    } as typeof f.store.writeMany;
    try { await assert.rejects(() => deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Concurrent paid material')]),
      e => e instanceof EngineError && e.code === 'selected_material_cut'); }
    finally { Store.prototype.writeMany = writeMany; }
    pendingIntent = reference(f.store.list<any>('research-consumer-intent').find(r => r.value.cursor?.deepPreparation && r.value.state === 'running')!);
  }
  let competing = '', calls: unknown, wires: unknown;
  const write = Store.prototype.atomicWrite;
  Store.prototype.atomicWrite = function(this: Store, prepare) {
    if (this !== f.store) return write.call(this, prepare);
    if (race === 'mode') modeOf(other, 'bypass');
    if (race === 'selection') revise(f, other);
    if (race === 'plan' || race === 'frame') {
      const q = other.get<Question>(race === 'plan' ? f.v.plan.id : f.v.draft.value.questions.find(id => other.get<Question>(id)?.value.spec.field === 'frame')!)!;
      new Discovery(other).reopen(q.id, q.revision);
    }
    if (race === 'P') applyDiscoveryAssessment(other, 'p', reference(pendingMR!));
    if (race === 'material') applyDeepResearch(other, 'p', pendingIntent!);
    competing = all(other); calls = money(other); wires = f.wires();
    return write.call(this, prepare);
  } as typeof f.store.atomicWrite;
  try { assert.throws(() => produceSelectedDossier(f.store, 'p', f.input), e => e instanceof EngineError); }
  finally { Store.prototype.atomicWrite = write; }
  assert.equal(all(f.store), competing); assert.deepEqual(money(f.store), calls); assert.deepEqual(f.wires(), wires);
  assert.equal(f.store.list(SELECTED_DOSSIER_KIND).length, 0); assert.equal(f.store.list(DOSSIER_MANIFEST_KIND).length, 0);
});
