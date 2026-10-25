import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { Discovery } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
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
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { V7_AXES, DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import type { VariantNone } from '../src/discovery/discovery-variants.js';
import { prepareDossierAssessmentSubject, checkDossierAssessmentResult } from '../src/discovery/dossier-assessment.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS, type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { projectDossierAssessment } from '../src/discovery/research-consumer-transition.js';

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
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial = false) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-65-projector-' }), project = 'p', runs = new Map<string, string>();
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
    const end = withMaterial && question === 'q-industry' ? { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT,
      value: { claims: [{ id: 'broad-rejected', kind: 'hypothesis', text: 'Real pre-choice rejected material', axis: 'industry',
        planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants: 'common' },
        basis: { howToVerify: 'Observe this bounded claim' } }] } } : undefined;
    const entry = await produce(g, end, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: end ? [{ claim: { project, container: entry.attempt, containerKind: 'research-attempt', pointer: '/claims/0', claimId: 'broad-rejected' }, reason: 'Rejected by the real paid assessment' }] : [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
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
  reply(typeof answer === 'function' ? answer(reference(saved)) : answer);
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
async function unchanged<T>(f: Paid, store: Store, action: () => Promise<T>, refuses = false): Promise<T | undefined> {
  const before = all(store), calls = money(store), wires = f.wires();
  let result: T | undefined;
  if (refuses) await assert.rejects(action, error => error instanceof EngineError);
  else result = await action();
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

function replyFor(packet: DossierAssessmentPacket, verdict: 'supported' | 'return' = 'supported'): DossierAssessmentResult {
  const bases = [{ record: packet.manifest.ref }];
  return { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: structuredClone(packet.subject), verdict,
    reasons: ['The saved dossier is assessed at its own boundary'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(dimension => [dimension,
      { judgement: 'adequate', reason: `Reviewed ${dimension} against the saved goal and scale`, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(item => item.address), unknowns: packet.unknowns.map(item => item.unknown.claim),
      contradictions: packet.contradictions.map(item => ({ id: item.contradiction.id,
        sides: item.sides.map(side => side.address) as [ClaimAddress, ClaimAddress], grounds: item.grounds.map(record => record.ref) })) },
    return: verdict === 'return' ? { targets: [{ axis: 'market' }], reason: 'Collect an addressed market basis', bases } : null };
}
function refusedResult(packet: DossierAssessmentPacket, result: unknown) {
  assert.throws(() => projectDossierAssessment({ packet, result }), error => error instanceof EngineError);
}

for (const model of [false, true])
test(`6.5 projector: real ${model ? 'model' : 'owner'} selected snapshot, support/return, exact identity and historical cold fixed point`, async t => {
  const f = await setup(t, model); await complete(f);
  const saved = produceSelectedDossier(f.store, 'p', f.input), root = reference(saved.record);
  const packet = (await unchanged(f, f.store, () => prepareDossierAssessmentSubject(f.store, 'p', root)))!;
  const result = replyFor(packet), original = canonical(result);
  const projection = (await unchanged(f, f.store, () => checkDossierAssessmentResult(f.store, 'p', packet.subject, result)))!;
  assert.equal(projection.completeness, 'complete'); assert.deepEqual(projection.blockingContradictions, []);
  assert.deepEqual(projection.packet, packet); assert.equal(canonical(result), original);
  assert.deepEqual(projectDossierAssessment({ packet, result }), projection);
  assert.equal('session' in projection, false); assert.equal('application' in projection, false);
  const returned = replyFor(packet, 'return'); returned.quality.sources.judgement = 'gap';
  returned.return!.targets = [{ claim: packet.materials[0]!.address }, { axis: 'market' }];
  returned.return!.bases = [{ claim: packet.materials[0]!.address }];
  const back = (await unchanged(f, f.store, () => checkDossierAssessmentResult(f.store, 'p', packet.subject, returned, packet)))!;
  assert.equal(back.result.verdict, 'return'); assert.notEqual(back.identity, projection.identity);
  assert.deepEqual(back.packet, packet);
  const late = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Late MR before application')]);
  const mr = await assess(f, late, 'unknown', false), second = produceSelectedDossier(f.store, 'p', f.input);
  const secondPacket = await prepareDossierAssessmentSubject(f.store, 'p', reference(second.record));
  assert.notEqual(secondPacket.subject.identity, packet.subject.identity);
  await unchanged(f, f.store, () => checkDossierAssessmentResult(f.store, 'p', secondPacket.subject, result), true);
  const other = await unchanged(f, f.store, () => checkDossierAssessmentResult(f.store, 'p', secondPacket.subject, replyFor(secondPacket)));
  assert.notEqual(other!.identity, projection.identity);
  applyDiscoveryAssessment(f.store, 'p', reference(mr)); revise(f); modeOf(f.store, model ? 'questions' : 'bypass'); nextPlan(f, f.store);
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    await unchanged(f, store, async () => {
      assert.deepEqual(await checkDossierAssessmentResult(store, 'p', packet.subject, result), projection);
      assert.deepEqual(await checkDossierAssessmentResult(store, 'p', packet.subject, returned, packet), back);
    });
  }
});

test('6.5 projector: retained counterarguments/unknowns, closed form and exact references; supported cannot hide open blocking', async t => {
  const f = await setup(t), entries = await complete(f), target = addresses(entries.industry)[0]!;
  const contrary = { ...(claim(f, 'q-market', 'market', 'Counterargument retained despite rejection') as Record<string, Json>),
    contradicts: [target], refutedBy: [target] } as unknown as Json;
  const rejected = await deep(f, 'q-market', [contrary]); await assess(f, rejected, 'rejected');
  const unknown = { ...(claim(f, 'q-market', 'market', 'Unassessed addressed gap') as Record<string, Json>), kind: 'unknown',
    basis: { origin: 'Named gap', unknownId: 'residual', question: 'Which deployment?', affects: ['deployment'],
      consumer: 'feasibility', blocksCurrentStage: false, moment: 'feasibility', closeCriterion: 'Identify deployment' } } as unknown as Json;
  const unknownEntry = await deep(f, 'q-market', [unknown]);
  const saved = produceSelectedDossier(f.store, 'p', f.input);
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', reference(saved.record));
  assert.equal(packet.contradictions.length, 2); assert.ok(packet.contradictions.some(item => item.contradiction.blocking));
  const result = replyFor(packet, 'return');
  result.return!.targets = packet.contradictions.map(item => ({ contradiction: item.contradiction.id }));
  result.return!.targets.push({ unknown: packet.unknowns[0]!.unknown.claim });
  result.return!.bases = packet.contradictions[0]!.sides.map(item => ({ claim: item.address }));
  const projected = (await unchanged(f, f.store, () => checkDossierAssessmentResult(f.store, 'p', packet.subject, result, packet)))!;
  assert.deepEqual(projected.packet, packet); assert.ok(projected.blockingContradictions.length);
  assert.ok(projected.packet.materials.some(item => item.status === 'rejected'));
  assert.equal(projected.packet.unknowns[0]!.material.status, 'unassessed');
  for (const relation of projected.packet.contradictions) for (const side of relation.sides) assert.ok((side.value as any).text);
  const fullBefore = all(f.store), beforeMoney = money(f.store), wire = f.wires();
  const invalid: unknown[] = [undefined, null, {}, { ...result, contract: 'dossier-assessment-result/v99' },
    { ...result, kind: 'attempts' }, { ...result, action: 'read_context' }, { ...result, complete: true },
    { ...result, verdict: 'supported', return: null }, { ...result, return: null }];
  const mutate = (change: (copy: any) => void) => { const copy = structuredClone(result); change(copy); invalid.push(copy); };
  for (const field of Object.keys(result)) {
    mutate(copy => { delete copy[field]; }); mutate(copy => { copy[field] = null; });
  }
  for (const dimension of DOSSIER_QUALITY_DIMENSIONS) {
    mutate(copy => { delete copy.quality[dimension]; }); mutate(copy => { copy.quality[dimension] = null; });
    for (const field of ['judgement', 'reason', 'bases']) {
      mutate(copy => { delete copy.quality[dimension][field]; }); mutate(copy => { copy.quality[dimension][field] = null; });
    }
    mutate(copy => { copy.quality[dimension].bases = []; });
    mutate(copy => { copy.quality[dimension].bases = [{ record: f.environment ? reference(f.environment) : null }]; });
  }
  for (const field of ['projectId', 'root', 'manifest', 'identity'])
    mutate(copy => { copy.subject[field] = field === 'projectId' ? 'foreign' : field === 'identity' ? 'other' : reference(f.environment); });
  for (const field of ['materials', 'unknowns', 'contradictions']) {
    mutate(copy => { delete copy.inventory[field]; }); mutate(copy => { copy.inventory[field] = null; });
    mutate(copy => { copy.inventory[field] = []; });
  }
  mutate(copy => { copy.inventory.materials[0].project = 'foreign'; });
  mutate(copy => { copy.inventory.contradictions[0].sides.reverse(); });
  mutate(copy => { copy.inventory.contradictions[0].sides.pop(); });
  mutate(copy => { copy.inventory.contradictions[0].grounds = [reference(f.environment)]; });
  mutate(copy => { copy.inventory.contradictions[0].blocking = false; });
  mutate(copy => { copy.inventory.contradictions[0].resolution = { state: 'scoped', dimension: 'region' }; });
  for (const targets of [[], [{ claim: { ...target, project: 'foreign' } }], [{ unknown: target }], [{ axis: 'foreign' }],
    [{ contradiction: 'foreign' }], [{ partialReason: 0 }], [{ claim: target, axis: 'market' }], [{ record: reference(saved.record) }]])
    mutate(copy => { copy.return.targets = targets; });
  for (const field of ['targets', 'reason', 'bases']) {
    mutate(copy => { delete copy.return[field]; }); mutate(copy => { copy.return[field] = null; });
  }
  mutate(copy => { copy.return.bases = [{ record: reference(f.environment) }]; });
  mutate(copy => { copy.return.bases = [{ claim: { ...target, claimId: 'foreign' } }]; });
  invalid.forEach(candidate => refusedResult(packet, candidate));
  assert.equal(all(f.store), fullBefore); assert.deepEqual(money(f.store), beforeMoney); assert.deepEqual(f.wires(), wire);
  // Caller packet cannot suppress either side, its status, unknowns, or the blocking resolution.
  const packets: unknown[] = [null, { ...packet, materials: packet.materials.slice(1) }, { ...packet, unknowns: [] },
    { ...packet, contradictions: [] }, { ...packet, root: packet.manifest }, { ...packet, manifest: packet.root }];
  const hidden = structuredClone(packet); hidden.contradictions[0]!.contradiction.blocking = false; packets.push(hidden);
  const side = structuredClone(packet); side.contradictions[0]!.sides.pop(); packets.push(side);
  const status = structuredClone(packet); status.materials.find(item => item.status === 'rejected')!.status = 'accepted'; packets.push(status);
  await assess(f, unknownEntry, 'material');
  const late = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Late material does not change the old contradiction')]);
  await assess(f, late, 'unknown'); revise(f); modeOf(f.store, 'bypass'); nextPlan(f, f.store);
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    for (const candidate of packets)
      await unchanged(f, store, () => checkDossierAssessmentResult(store, 'p', packet.subject, result, candidate), true);
    await unchanged(f, store, () => checkDossierAssessmentResult(store, 'p', packet.subject, replyFor(packet)), true);
    for (const subject of [undefined, null, {}, { ...packet.subject, projectId: 'foreign' },
      { ...packet.subject, contract: 'unknown' }, { ...packet.subject, manifest: reference(saved.record) }])
      await unchanged(f, store, () => checkDossierAssessmentResult(store, 'p', subject, result), true);
    await unchanged(f, store, () => checkDossierAssessmentResult(store, 'foreign', packet.subject, result), true);
    await unchanged(f, store, async () => assert.deepEqual(await checkDossierAssessmentResult(store, 'p', packet.subject, result), projected));
    const lost = packet.unknowns[0]!.material.address.container, get = store.get;
    store.get = ((id, rev) => id === lost.id ? null : get.call(store, id, rev)) as typeof store.get;
    try { await unchanged(f, store, () => checkDossierAssessmentResult(store, 'p', packet.subject, result, packet), true); }
    finally { delete (store as any).get; }
  }
});

test('6.5 projector: genuine nonempty partial may be assessed for quality, never becomes complete or a selected product', async t => {
  const f = await paid(t, (snapshot: Ref) => ({ action: 'no_variants', reasons: [{ code: 'bounded_search',
    message: 'No bounded variant', grounds: [snapshot] }], searchLimits: ['Saved sweep only'], unknowns: ['Demand unknown'] }), true);
  const none = f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const handoff = await publishVariantHandoff(f.store, 'p', { draft: reference(f.store.get(f.draft.id)!), result: reference(none),
    decision: null, scope: null, earlyLimit: false });
  const saved = await producePartialDossier(f.store, 'p', reference(handoff.record));
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', reference(saved.record));
  assert.ok(packet.materials.some(item => item.status === 'rejected')); assert.equal(packet.route.scope, null);
  const result = replyFor(packet), back = replyFor(packet, 'return');
  back.return!.targets = [{ partialReason: 0 }, { claim: packet.materials[0]!.address }]; back.quality.alternatives.judgement = 'gap';
  const supported = (await unchanged(f, f.store, () => checkDossierAssessmentResult(f.store, 'p', packet.subject, result)))!;
  const returned = (await unchanged(f, f.store, () => checkDossierAssessmentResult(f.store, 'p', packet.subject, back, packet)))!;
  assert.equal(supported.completeness, 'partial'); assert.equal(supported.subject.root.kind, 'partial');
  assert.deepEqual(supported.packet.manifest.value.reasons, packet.manifest.value.reasons);
  assert.equal('accepted' in supported, false); assert.equal('selected' in supported, false);
  const gap = replyFor(packet); gap.quality.sources.judgement = 'gap'; refusedResult(packet, gap);
  const wrong = structuredClone(back); wrong.return!.targets = [{ partialReason: 1 }]; refusedResult(packet, wrong);
  modeOf(f.store, 'bypass'); nextPlan(f, f.store);
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    await unchanged(f, store, async () => {
      assert.deepEqual(await checkDossierAssessmentResult(store, 'p', packet.subject, result), supported);
      assert.deepEqual(await checkDossierAssessmentResult(store, 'p', packet.subject, back, packet), returned);
    });
    await unchanged(f, store, () => checkDossierAssessmentResult(store, 'p', packet.subject, result,
      { ...packet, manifest: { ...packet.manifest, value: { ...packet.manifest.value, completeness: 'complete', reasons: [] } } }), true);
  }
});
