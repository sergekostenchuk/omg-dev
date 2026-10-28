import { fixtureApplicableAxes } from './discovery-v7-fixture.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
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
import { prepareDossierAssessmentSubject, requireDossierAssessmentSubject, requireDossierAssessmentPacket } from '../src/discovery/dossier-assessment.js';
import { DOSSIER_ASSESSMENT_SUBJECT_CONTRACT, DOSSIER_ASSESSMENT_PACKET_CONTRACT } from '../src/discovery/research-model.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';

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
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-64-subject-' }), project = 'p', runs = new Map<string, string>();
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
/** The per-action part of a read check: the real refusal or result through
 * the accepted storeUnchanged/storeRefused window — the Store's own commits
 * plus SQLite data_version must be equal, so a write by any connection is
 * seen — and the model wire compared directly around the very action, so a
 * one-off adapter call that writes nothing is still caught at its own door.
 * The full heads/revisions dump, the paid calls and the budget ledger are
 * compared once per read-only fixed-point block in fixed(), not once per row. */
async function still<T>(f: Pick<Paid, 'wires'>, store: Store, action: () => Promise<T>, refuses = false): Promise<T | undefined> {
  const wires = f.wires();
  if (refuses) { await storeRefused(store, action); assert.deepEqual(f.wires(), wires); return undefined; }
  const result = await storeUnchanged(store, action);
  assert.deepEqual(f.wires(), wires);
  return result;
}
/** One byte fixed point per read-only block: the complete heads/revisions
 * dump plus the paid calls, the ledger and the wire are compared across the
 * whole block while every action inside keeps its own stamp window — a write
 * anywhere is caught exactly once per block, not once per row. */
async function fixed<T>(f: Paid, store: Store, block: () => Promise<T>): Promise<T> {
  const before = all(store), calls = money(store), wires = f.wires(), result = await block();
  assert.equal(all(store), before); assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  return result;
}
/** A byte fork of a world real producers already built: VACUUM INTO copies
 * the whole file into a new Store — every saved record, revision and hash
 * identical at the fork point — and each test continues on its own isolated
 * copy, so its later writes never reach another test's world. The fork is
 * never a stand-in for a producer run; it only avoids repeating one. */
const forkDir = mkdtempSync(join(tmpdir(), 'omg-64-fork-'));
/** A shared base world is built on this file-level context instead of a
 * test's own: its fixture cleanup is collected and runs once at file end, so
 * the root, settings, wire and adapter it produced stay alive for every
 * fork. */
const baseTeardowns: (() => void)[] = [];
const baseT = { after: (fn: () => void) => { baseTeardowns.push(fn); } } as test.TestContext;
after(() => { for (const fn of baseTeardowns.splice(0)) fn(); });
function forkStore(t: test.TestContext, store: Store): Store {
  const copy = join(forkDir, `fork-${rand()}.sqlite`);
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); } finally { db.close(); }
  const clone = new Store(copy);
  t.after(() => { clone.close(); try { rmSync(copy); } catch {} });
  return clone;
}
async function selectWorld(f: Paid, model = false) {
  const decision = model ? await modelChoose(f) : selected(f).act.decision;
  const scope = publishVariantScope(f.store, 'p', reference(decision)).scope;
  return { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
}
type Selected = Awaited<ReturnType<typeof selectWorld>>;
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
  const industry = await deep(f, 'q-industry', fixtureApplicableAxes(f.v.draft).map(axis => claim(f, 'q-industry', axis, `Exact ${axis} evidence`)));
  await assess(f, industry);
  const market = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Market cell evidence')]);
  await assess(f, market);
  return { industry, market };
}
type CompleteWorld = Selected & { entries: { industry: Entry; market: Entry } };
/** The one producer-built paid world of this file — two assessed plan
 * questions, the variant snapshot and the paid two-member set — byte-forked
 * per test. The fork point is before the decision because the set admits
 * exactly one actor: owner and model each choose on their own copy. The
 * owner-decided complete sweep is shared as well: the owner test and the
 * statuses test read the same real past on their own isolated stores. */
let paidBase: Paid | null = null, completeBase: CompleteWorld | null = null;
async function paidWorld(t: test.TestContext): Promise<Paid> {
  if (!paidBase) paidBase = await paid(baseT);
  return { ...paidBase, store: forkStore(t, paidBase.store) } as Paid;
}
async function completeWorld(t: test.TestContext): Promise<CompleteWorld> {
  if (!completeBase) {
    if (!paidBase) paidBase = await paid(baseT);
    const f = { ...paidBase, store: forkStore(baseT, paidBase.store) } as Paid;
    const selected = await selectWorld(f), entries = await complete(selected);
    completeBase = { ...selected, entries };
  }
  return { ...completeBase, store: forkStore(t, completeBase.store) };
}
async function modelWorld(t: test.TestContext): Promise<CompleteWorld> {
  const selected = await selectWorld(await paidWorld(t), true), entries = await complete(selected);
  return { ...selected, entries };
}
function revise(f: Selected, store = f.store) {
  const state = store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const scope: VariantChoiceScope = { ...f.scope!, mode: reference(store.get('project-mode:p')!), operation: store.get(state.value.decision!.id)!.kind === 'discovery-variant-model-decision' ? 'override' : 'revise',
    previous: state.value.decision!, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'Owner changes chosen member' } };
  return answerVariantChoice(store, scope, mint(store, scope).authority);
}

for (const model of [false, true])
test(`6.4 dossier subject: real ${model ? 'model' : 'owner'} complete snapshot has one exact historical packet without writes or payment`, async t => {
  const f = model ? await modelWorld(t) : await completeWorld(t);
  const saved = produceSelectedDossier(f.store, 'p', f.input), root = reference(saved.record);
  const packet = (await still(f, f.store, () => prepareDossierAssessmentSubject(f.store, 'p', root)))!;
  await still(f, f.store, async () => assert.deepEqual(await prepareDossierAssessmentSubject(f.store, 'p', root), packet));
  assert.equal(packet.subject.contract, DOSSIER_ASSESSMENT_SUBJECT_CONTRACT);
  assert.equal(packet.subject.kind, 'dossier'); assert.equal(packet.subject.root.kind, 'selected');
  assert.equal(packet.contract, DOSSIER_ASSESSMENT_PACKET_CONTRACT);
  assert.deepEqual(packet.manifest.ref, reference(saved.manifest));
  assert.equal(packet.manifest.value.completeness, 'complete');
  assert.equal(packet.coverage!.missing.length, 0);
  assert.ok(packet.route.scope && packet.route.set && packet.route.member && packet.route.decision);
  for (const axis of V7_AXES) for (const address of packet.manifest.value.axes[axis].claims)
    assert.ok(packet.materials.some(item => canonical(item.address) === canonical(address) && (item.value as any).text));
  assert.equal(packet.materials.filter(item => item.status === 'accepted').length, 3);
  const late = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Late unknown reopens current coverage')]);
  const mr = await assess(f, late, 'unknown', false);
  const second = produceSelectedDossier(f.store, 'p', f.input);
  const secondPacket = (await still(f, f.store, () => prepareDossierAssessmentSubject(f.store, 'p', reference(second.record))))!;
  assert.notEqual(secondPacket.subject.identity, packet.subject.identity);
  applyDiscoveryAssessment(f.store, 'p', reference(mr));
  revise(f); modeOf(f.store, model ? 'questions' : 'bypass'); nextPlan(f, f.store);
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    await fixed(f, store, () => still(f, store, async () => {
      assert.deepEqual(await prepareDossierAssessmentSubject(store, 'p', root), packet);
      assert.deepEqual(await requireDossierAssessmentSubject(store, 'p', packet.subject), packet);
      assert.deepEqual(await requireDossierAssessmentPacket(store, 'p', packet), packet);
    }));
  }
});

test('6.4 dossier subject: all statuses, addressed unknown and both blocking contradiction/refutation sides carry content; truncation refuses', async t => {
  const f = await completeWorld(t), target = addresses(f.entries.industry)[0]!;
  const contrary = { ...(claim(f, 'q-market', 'market', 'Retained counterargument') as Record<string, Json>),
    contradicts: [target], refutedBy: [target] } as unknown as Json;
  const rejected = await deep(f, 'q-market', [contrary]); await assess(f, rejected, 'rejected');
  const unknown = { ...(claim(f, 'q-market', 'market', 'Residual addressed uncertainty') as Record<string, Json>), kind: 'unknown',
    basis: { origin: 'Named gap', unknownId: 'residual', question: 'Which deployment?', affects: ['deployment'],
      consumer: 'feasibility', blocksCurrentStage: false, moment: 'feasibility', closeCriterion: 'Identify deployment' } } as unknown as Json;
  await deep(f, 'q-market', [unknown]);
  const saved = produceSelectedDossier(f.store, 'p', f.input), root = reference(saved.record);
  const packet = (await still(f, f.store, () => prepareDossierAssessmentSubject(f.store, 'p', root)))!;
  assert.ok(packet.materials.some(item => item.status === 'rejected' && (item.value as any).text === 'Retained counterargument' && item.assessment));
  assert.equal(packet.unknowns[0]!.material.status, 'unassessed');
  assert.equal((packet.unknowns[0]!.material.value as any).basis.question, 'Which deployment?');
  assert.equal(packet.contradictions.length, 2);
  assert.ok(packet.contradictions.some(item => item.contradiction.blocking && item.contradiction.resolution.state === 'open'));
  for (const relation of packet.contradictions) for (const side of relation.sides) {
    assert.ok((side.value as any).text); assert.ok(side.container.value);
    assert.ok(packet.materials.some(item => canonical(item.address) === canonical(side.address)));
  }
  // Only exact roots are inputs, never structural completeness or caller arrays.
  await fixed(f, f.store, async () => {
    for (const input of [undefined, null, {}, { ...root, revision: null }, { ...root, hash: '0'.repeat(64) },
      { ...root, id: 'foreign-root' }, { root, complete: true }, reference(saved.manifest)])
      await still(f, f.store, () => prepareDossierAssessmentSubject(f.store, 'p', input), true);
    await still(f, f.store, () => prepareDossierAssessmentSubject(f.store, 'foreign', root), true);
    for (const field of Object.keys(packet.subject)) {
      const missing: any = structuredClone(packet.subject); delete missing[field];
      await still(f, f.store, () => requireDossierAssessmentSubject(f.store, 'p', missing), true);
      await still(f, f.store, () => requireDossierAssessmentSubject(f.store, 'p', { ...packet.subject, [field]: null }), true);
    }
    for (const candidate of [{ ...packet.subject, contract: 'dossier-assessment-subject/v99' },
      { ...packet.subject, kind: 'attempts' }])
      await still(f, f.store, () => requireDossierAssessmentSubject(f.store, 'p', candidate), true);
    const wrong: any = { ...packet.subject, manifest: root }; delete wrong.identity;
    wrong.identity = `dossier-assessment:p:${hashJson(wrong)}`;
    await still(f, f.store, () => requireDossierAssessmentSubject(f.store, 'p', wrong), true);
    const truncated = structuredClone(packet); truncated.contradictions[0]!.sides.pop();
    for (const candidate of [{ ...packet, contract: 'dossier-assessment-packet/v99' }, { ...packet, manifest: packet.root },
      { ...packet, materials: packet.materials.slice(1) }, { ...packet, unknowns: [] },
      { ...packet, contradictions: [] }, truncated])
      await still(f, f.store, () => requireDossierAssessmentPacket(f.store, 'p', candidate), true);
  });
  const lost = packet.unknowns[0]!.material.address.container;
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    await fixed(f, store, async () => {
      await still(f, store, async () => assert.deepEqual(await requireDossierAssessmentPacket(store, 'p', packet), packet));
      const get = store.get;
      store.get = ((id, rev) => id === lost.id ? null : get.call(store, id, rev)) as typeof store.get;
      try { await still(f, store, () => requireDossierAssessmentSubject(store, 'p', packet.subject), true); }
      finally { delete (store as any).get; }
    });
  }
});

test('6.4 dossier subject: genuine no_variants partial keeps nonempty rejected material and historical reasons without an invented scope', async t => {
  const f = await paid(t, (snapshot: Ref) => ({ action: 'no_variants', reasons: [{ code: 'bounded_search',
    message: 'No bounded variant', grounds: [snapshot] }], searchLimits: ['Saved sweep only'], unknowns: ['Demand unknown'] }), true);
  const none = f.store.list<VariantNone>('discovery-variant-none')[0]!; assert.ok(none);
  const handoff = await publishVariantHandoff(f.store, 'p', { draft: reference(f.store.get(f.draft.id)!),
    result: reference(none), decision: null, scope: null, earlyLimit: false });
  const saved = await producePartialDossier(f.store, 'p', reference(handoff.record)), root = reference(saved.record);
  const packet = (await still(f, f.store, () => prepareDossierAssessmentSubject(f.store, 'p', root)))!;
  assert.equal(packet.subject.root.kind, 'partial'); assert.equal(packet.manifest.value.completeness, 'partial');
  assert.equal(packet.manifest.value.reasons[0]!.code, 'no_variants');
  assert.equal(packet.coverage, null); assert.equal(packet.route.scope, null); assert.equal(packet.route.member, null);
  assert.ok(packet.route.handoff && packet.route.result && packet.route.snapshot);
  assert.ok(packet.materials.some(item => item.status === 'rejected' && (item.value as any).text === 'Real pre-choice rejected material'));
  modeOf(f.store, 'bypass'); nextPlan(f, f.store);
  for (const store of [f.store, new Store(f.store.path)]) {
    if (store !== f.store) t.after(() => store.close());
    await fixed(f, store, () => still(f, store, async () => {
      assert.deepEqual(await prepareDossierAssessmentSubject(store, 'p', root), packet);
      assert.deepEqual(await requireDossierAssessmentSubject(store, 'p', packet.subject), packet);
      assert.deepEqual(await requireDossierAssessmentPacket(store, 'p', packet), packet);
    }));
  }
});

