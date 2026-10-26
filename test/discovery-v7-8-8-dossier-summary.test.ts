import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { storeRefused, storeUnchanged } from './store-unchanged.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession, type VariantSessionInput } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet, type VariantNone } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION, type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope, readVariantScope } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand, validPlan, discoveryFixture, acceptPlan, planQuestion, type PlanQuestion } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';
import { DISCOVERY_DEEP_PREPARATION_CONTRACT, produceDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { V7_AXES, V7_STAGE_TOKEN_CEILING, DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { resolveClaimAddress, type ClaimAddress } from '../src/discovery/claim-address.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier, projectDossierManifest, DOSSIER_MANIFEST_KIND, readPartialDossier, type DossierManifest } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff, readVariantHandoff, readDeepFrontierStop } from '../src/discovery/discovery-outcome.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { stageSummary, renderStageSummary, type DossierSnapshotStageSummary, type DossierSnapshotSummaryRequest, type SummaryDossierAddress } from '../src/product/stage-summary.js';

// The 8.8 summary of the proven D6 snapshot: an exact selected carrier or partial manifest in, one historical read-only summary out.
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

/** The real paid line of 6.4: two assessed plan questions, the variant snapshot, real project modes and the real
 * paid generation of a two-member set with its first state. */
async function paid(t: test.TestContext, answer: unknown = generation(), withMaterial = false) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-88-summary-' }), project = 'p', runs = new Map<string, string>();
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
/** The real paid bypass model decision over the current set. */
async function modelChoose(f: Awaited<ReturnType<typeof paid>>) {
  const mode = modeOf(f.store, 'bypass');
  f.reply({ action: 'choose', key: 'v1', reason: 'Real paid model choice' });
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

// Every heads/history row, the paid calls, the budget ledger and the model wire must be untouched by a summary.
// The dump compares identity + kind + the stored sha256 of every revision — the content hash written
// with the row — instead of hauling every body: a committed write always lands in this projection.
const all = (store: Store) => {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
    revisions: db.prepare('SELECT entity_id,revision,kind,sha256 FROM revisions ORDER BY entity_id,revision').all() } as never); }
  finally { db.close(); }
};
/** The cheap part of a read check, kept on every action: the real refusal or
 * result through the accepted storeUnchanged/storeRefused window (the Store's
 * own commits + SQLite data_version must be equal — any write to the file by
 * any connection moves the stamp), plus the paid calls, the budget ledger and
 * the model wire byte-identical. The full heads/revisions dump is not per
 * action: it happens once per read-only fixed-point block in fixed(). */
async function still<T>(store: Store, action: () => Promise<T>, refuses: boolean | string = false): Promise<T | undefined> {
  if (refuses) { await storeRefused(store, action, error => error instanceof EngineError && (refuses === true || (error as EngineError).code === refuses)); return undefined; }
  return await storeUnchanged(store, action);
}
/** One byte fixed point per read-only block: the full heads/revisions dump,
 * the paid calls, the budget ledger and the model wire are compared across
 * the whole block while every action inside keeps its own stamp window — a
 * write anywhere is caught exactly once per block, not once per row. */
async function fixed<T>(f: { wires: () => unknown }, store: Store, block: () => Promise<T>): Promise<T> {
  const before = all(store), calls = money(store), wires = f.wires(), result = await block();
  assert.equal(all(store), before); assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  return result;
}
/** A byte fork of a world real producers already built: VACUUM INTO copies the
 * whole file into a new Store — every saved record, revision and hash identical
 * at the fork point — and each test continues on its own isolated copy, so its
 * later writes never reach another test's world. The fork is never a stand-in
 * for a producer run; it only avoids repeating one. */
const forkDir = mkdtempSync(join(tmpdir(), 'omg-88-fork-'));
/** A shared base world is built on this file-level context instead of a test's
 * own: its fixture cleanup is collected and runs once at file end, so the
 * root, settings, wire and adapter it produced stay alive for every fork. */
const baseTeardowns: (() => void)[] = [];
const baseT = { after: (fn: () => void) => { baseTeardowns.push(fn); } } as test.TestContext;
after(() => { for (const fn of baseTeardowns.splice(0)) fn(); });
/** VACUUM INTO writes the whole logical database — WAL included — as one
 * standalone file; the fork is never a stand-in for a producer run, it only
 * avoids repeating one. */
function forkStore(t: test.TestContext, store: Store): Store {
  const copy = join(forkDir, `fork-${rand()}.sqlite`);
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); } finally { db.close(); }
  const clone = new Store(copy);
  t.after(() => { clone.close(); try { rmSync(copy); } catch {} });
  return clone;
}
async function selectWorld(f: Paid, model = false) {
  const decision = model ? await modelChoose(f)
    : (() => { const act = answerVariantChoice(f.store, f.scope!, mint(f.store, f.scope!).authority); return act.decision; })();
  const scope = publishVariantScope(f.store, 'p', reference(decision)).scope;
  return { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
}
type Selected = Awaited<ReturnType<typeof selectWorld>>;
type CompleteWorld = Selected & { entries: { industry: Entry; market: Entry } };
/** The one producer-built paid world of the complete-snapshot section —
 * calibrated, variant set generated — byte-forked per test. The fork point is
 * before the decision because the set admits exactly one actor: owner and
 * model each choose on their own isolated copy, then run the same complete
 * sweep there. */
let paidBase: Paid | null = null;
async function completeWorld(t: test.TestContext, model: boolean): Promise<CompleteWorld> {
  if (!paidBase) paidBase = await paid(baseT);
  const f = { ...paidBase, store: forkStore(t, paidBase.store) } as Paid;
  const selected = await selectWorld(f, model), entries = await complete(selected);
  return { ...selected, entries };
}
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
async function assess(f: Selected, entry: Entry, outcome: 'closed' | 'open' | 'unknown' | 'rejected' = 'closed', apply = true) {
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

// ---- 8.8 helpers: the one public asynchronous section of stageSummary, its text, and a resolver proving that every returned address is real ----
const summarize = (store: Store, root: unknown, project = 'p') => stageSummary(store, project, 'discovery', { section: 'dossier-snapshot', root } as DossierSnapshotSummaryRequest);
const refText = (ref: Ref): string => `${ref.id}@${ref.revision}#${ref.hash}`;
const jsonOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Walk an address to the exact saved value it names; a lost record, a changed hash or a pointer leaving the value fails here. */
function resolve(store: Store, address: { record: Ref; pointer: string }): any {
  const row = store.get<any>(address.record.id, address.record.revision);
  assert.ok(row, `address record ${address.record.id} is saved`); assert.equal(row.hash, address.record.hash);
  let value: any = row.value;
  for (const part of address.pointer.split('/').slice(1)) {
    assert.ok(value !== null && typeof value === 'object' && Object.hasOwn(value, part.replace(/~1/g, '/').replace(/~0/g, '~')),
      `pointer ${address.pointer} stays inside ${address.record.id}`);
    value = value[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return value;
}
/** A returned next-step address, resolved the way its kind is proven: a record pointer is walked, a claim goes through the claim-address door. */
function resolveNext(store: Store, address: SummaryDossierAddress): any {
  if (address.kind === 'record') return resolve(store, address);
  const found = resolveClaimAddress(store, address.claim);
  assert.equal((found.claim as any).id, address.claim.claimId);
  return found.claim;
}
const countOf = (rows: { status: string }[], status: string) => rows.filter(row => row.status === status).length;
function assertAwaiting(summary: DossierSnapshotStageSummary, text: string) {
  assert.deepEqual(summary.snapshot.assessment, { state: 'awaiting', supported: false, accepted: false, conceptAdmission: false });
  assert.match(text, /ожидание оценки/); assert.match(text, /допуска к concept нет/);
  assert.doesNotMatch(text, /supported: true|accepted: true|conceptAdmission: true/);
}

/** The identical complete-snapshot assertions, run once for the owner decision
 * and once for a real model decision — each on its own fork of the same
 * producer-built world; only the decision kind differs. */
async function completeSnapshot(t: test.TestContext, f: CompleteWorld, model: boolean) {
  const saved = produceSelectedDossier(f.store, 'p', f.input), root = reference(saved.record), carrier = saved.record.value;
  const summary = (await still(f.store, () => summarize(f.store, root)))!, s = summary.snapshot;
  await still(f.store, async () => assert.deepEqual(await summarize(f.store, root), summary));
  assert.equal(summary.contract, 'stage-summary/dossier-snapshot/v1'); assert.equal(summary.project, 'p'); assert.equal(summary.stage, 'discovery');
  assert.deepEqual(s.root, { kind: 'selected', ref: root });
  assert.deepEqual(s.manifest, reference(saved.manifest));
  assert.equal(s.completeness, 'complete');
  assert.deepEqual(s.basis, { draft: carrier.draft, frame: carrier.frame, plan: carrier.plan });
  assert.deepEqual(f.input.scope, carrier.scope);
  assert.deepEqual(s.route.scope, carrier.scope);
  assert.deepEqual([s.route.set, s.route.member, s.route.decision], [carrier.set, carrier.member, carrier.decision]);
  assert.deepEqual(s.coverage, { cells: saved.coverage.cells.length, missing: 0 });
  assert.deepEqual(s.axes.map(row => row.axis), [...V7_AXES]);
  for (const row of s.axes) {
    assert.equal(row.depth, saved.manifest.value.axes[row.axis].depth);
    assert.equal(row.claims, saved.manifest.value.axes[row.axis].claims.length);
  }
  assert.equal(s.axes.reduce((sum, row) => sum + row.claims, 0), 13);
  assert.deepEqual(s.materials, { accepted: countOf(saved.materials, 'accepted'), rejected: countOf(saved.materials, 'rejected'), unassessed: countOf(saved.materials, 'unassessed') });
  assert.equal(s.materials.accepted, 13);
  assert.deepEqual([s.unknowns, s.contradictions, s.partial, s.stop], [[], [], null, null]);
  // The only next step of a full snapshot is its assessment, addressed at the exact root.
  assert.deepEqual(s.next.map(step => step.action), ['assess-dossier']);
  assert.deepEqual(s.next[0]!.address, { kind: 'record', record: root, pointer: '' });
  assert.deepEqual(resolveNext(f.store, s.next[0]!.address), saved.record.value);
  // JSON and text carry the same exact snapshot and never turn complete into an acceptance.
  assert.deepEqual(jsonOf(summary), summary);
  const text = renderStageSummary(summary);
  for (const ref of [root, s.manifest, carrier.draft, carrier.frame, carrier.plan, carrier.scope, carrier.set, carrier.member, carrier.decision])
    assert.ok(text.includes(refText(ref)), refText(ref));
  assert.match(text, /полный снимок \(complete\) — это не оценка и не принятие/);
  assert.match(text, /assess-dossier/);
  assertAwaiting(summary, text);
  // A late unknown reopens current coverage: its snapshot is a different subject and the first summary stays what it was.
  const late = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'Late unknown reopens current coverage')]);
  const mr = await assess(f, late, 'unknown', false);
  const second = produceSelectedDossier(f.store, 'p', f.input);
  const later = (await still(f.store, () => summarize(f.store, reference(second.record))))!;
  assert.notEqual(later.snapshot.subject, s.subject); assert.notDeepEqual(later.snapshot.root, s.root);
  assert.deepEqual(await summarize(f.store, root), summary);
  applyDiscoveryAssessment(f.store, 'p', reference(mr));
  revise(f); modeOf(f.store, model ? 'questions' : 'bypass'); nextPlan(f, f.store);
  // The historical block is read-only end to end: one byte fixed point over it.
  await fixed(f, f.store, async () => {
    for (const store of [f.store, new Store(f.store.path)]) {
      if (store !== f.store) t.after(() => store.close());
      await still(store, async () => {
        assert.deepEqual(await summarize(store, root), summary);
        assert.deepEqual(await summarize(store, reference(second.record)), later);
        assert.equal(renderStageSummary(await summarize(store, root)), text);
      });
    }
  });
}

for (const model of [false, true])
test(`8.8 dossier summary: real ${model ? 'model' : 'owner'} complete snapshot is one exact historical summary awaiting assessment, without writes or payment`, async t => {
  const f = await completeWorld(t, model);
  await completeSnapshot(t, f, model);
});

test('8.8 dossier summary: addressed unknown and both blocking contradiction sides keep content and resolvable return addresses; wrong inputs refuse', async t => {
  const f = await completeWorld(t, false), entries = f.entries, target = addresses(entries.industry)[0]!;
  const contrary = { ...(claim(f, 'q-market', 'market', 'Retained counterargument') as Record<string, Json>),
    contradicts: [target], refutedBy: [target] } as unknown as Json;
  const rejected = await deep(f, 'q-market', [contrary]); await assess(f, rejected, 'rejected');
  const unknown = { ...(claim(f, 'q-market', 'market', 'Residual addressed uncertainty') as Record<string, Json>), kind: 'unknown',
    basis: { origin: 'Named gap', unknownId: 'residual', question: 'Which deployment?', affects: ['deployment'],
      consumer: 'feasibility', blocksCurrentStage: false, moment: 'feasibility', closeCriterion: 'Identify deployment' } } as unknown as Json;
  await deep(f, 'q-market', [unknown]);
  const saved = produceSelectedDossier(f.store, 'p', f.input), root = reference(saved.record);
  const summary = (await still(f.store, () => summarize(f.store, root)))!, s = summary.snapshot;
  // A complete snapshot may still carry open uncertainty and conflict: complete is never "nothing left to answer".
  assert.equal(s.completeness, 'complete');
  assert.deepEqual(s.materials, { accepted: countOf(saved.materials, 'accepted'), rejected: countOf(saved.materials, 'rejected'), unassessed: countOf(saved.materials, 'unassessed') });
  assert.ok(s.materials.rejected >= 1 && s.materials.unassessed >= 1);
  assert.equal(s.unknowns.length, 1);
  const open = s.unknowns[0]!;
  assert.deepEqual([open.unknownId, open.consumer, open.moment, open.blocksCurrentStage, open.status, open.text],
    ['residual', 'feasibility', 'feasibility', false, 'unassessed', 'Residual addressed uncertainty']);
  assert.equal((resolveClaimAddress(f.store, open.claim).claim as any).id, open.claim.claimId);
  assert.equal(s.contradictions.length, 2);
  for (const row of s.contradictions) {
    assert.deepEqual([row.blocking, row.resolution, row.grounds], [true, 'open', []]);
    assert.equal(resolve(f.store, row.address).id, row.id);
    assert.equal(row.sides.length, 2);
    for (const side of row.sides) {
      assert.ok(side.text); assert.ok(['accepted', 'rejected', 'unassessed'].includes(side.status));
      assert.equal((resolveClaimAddress(f.store, side.claim).claim as any).id, side.claim.claimId);
      // The exact progress application that classified the side, when there is one, is a saved application record.
      if (side.application) assert.equal(f.store.get(side.application.id, side.application.revision)?.kind, 'v7-progress-application');
    }
  }
  assert.ok(s.contradictions.some(row => row.sides.some(side => side.application)));
  assert.ok(s.contradictions.some(row => row.sides.some(side => side.status === 'rejected' && side.text === 'Retained counterargument')));
  // Both sides, in their saved order, are the manifest's own two claims: neither is repeated, dropped or swapped.
  const declared = saved.manifest.value.contradictions;
  assert.deepEqual(s.contradictions.map(row => row.id), declared.map(row => row.id));
  s.contradictions.forEach((row, index) => {
    assert.deepEqual(row.sides.map(side => [side.claim, side.status]), declared[index]!.sides.map(side => [side.claim, side.status]));
    assert.notEqual(row.sides[0].claim.claimId, row.sides[1].claim.claimId);
  });
  const actions = s.next.map(step => step.action);
  assert.deepEqual(actions, ['close-unknown', 'resolve-contradiction', 'resolve-contradiction', 'assess-dossier']);
  for (const step of s.next) assert.notEqual(resolveNext(f.store, step.address), undefined);
  assert.deepEqual(s.next[0]!.address, { kind: 'claim', claim: open.claim });
  assert.deepEqual(s.next.slice(1, 3).map(step => step.address), s.contradictions.map(row => ({ kind: 'record', ...row.address })));
  const text = renderStageSummary(summary);
  for (const piece of ['Residual addressed uncertainty', 'Retained counterargument', 'блокирует', 'разрешение open', 'close-unknown', 'resolve-contradiction'])
    assert.ok(text.includes(piece), piece);
  assertAwaiting(summary, text);
  assert.deepEqual(jsonOf(summary), summary);

  // Only an exact saved root of this project is an input; structural completeness, caller arrays and neighbours never are.
  const valid = { section: 'dossier-snapshot', root };
  const ask = async (request: unknown, project = 'p', stage: unknown = 'discovery', store = f.store) =>
    (stageSummary as (...args: unknown[]) => unknown)(store, project, stage, request);
  const shaped = 'stage_summary_dossier_request_invalid';
  // Every wrong input below refuses and writes nothing: the whole table is one byte fixed point.
  await fixed(f, f.store, async () => {
    for (const request of [{ section: 'dossier-snapshot' }, { section: 'dossier-snapshot', decision: s.route.decision }, { section: 'dossier-snapshot', root: null },
      { section: 'dossier-snapshot', root: undefined }, { section: 'dossier-snapshot', root: [root] }, { section: 'dossier-snapshot', root, complete: true },
      { section: 'dossier-snapshot', root, manifest: reference(saved.manifest) }, { section: 'dossier-snapshot', root: { ...root, revision: null } },
      { section: 'dossier-snapshot', root: { id: root.id, revision: root.revision } }])
      await still(f.store, () => ask(request), shaped);
    for (const stage of ['concept', 'design', null, 'Discovery', 7])
      await still(f.store, () => ask(valid, 'p', stage), shaped);
    // A well-formed request that names no exact saved root of this project is the proof door's typed refusal.
    for (const request of [{ section: 'dossier-snapshot', root: { ...root, hash: '0'.repeat(64) } }, { section: 'dossier-snapshot', root: { ...root, id: 'foreign-root' } },
      { section: 'dossier-snapshot', root: reference(saved.manifest) }, { section: 'dossier-snapshot', root: carrierPart(saved, 'decision') },
      { section: 'dossier-snapshot', root: carrierPart(saved, 'scope') }, { section: 'dossier-snapshot', root: carrierPart(saved, 'plan') },
      { section: 'dossier-snapshot', root: { id: reference(saved.manifest).id, revision: reference(saved.manifest).revision, hash: root.hash } },
      { section: 'dossier-snapshot', root: { id: root.id, revision: root.revision, hash: reference(saved.manifest).hash } }])
      await still(f.store, () => ask(request), true);
    await still(f.store, () => ask(valid, 'foreign'), true);
    // Without the section name the request is not this door's at all: the synchronous index check refuses it.
    for (const request of [null, {}, [], [root], { root }, { section: 'dossier-summary', root }])
      await still(f.store, () => ask(request), 'stage_summary_index_request_invalid');
    // Only this section answers with a Promise; the synchronous sections keep throwing synchronously and refuse what is not theirs.
    await still(f.store, async () => assert.ok(stageSummary(f.store, 'p', 'discovery', valid as DossierSnapshotSummaryRequest) instanceof Promise));
    await still(f.store, async () => assert.throws(() => stageSummary(f.store, 'p', 'discovery', { section: 'dossier-summary', root } as never),
      (error: unknown) => error instanceof EngineError && error.code === 'stage_summary_index_request_invalid'));
    // A lost exact ground is a refusal, never a quiet "unassessed" downgrade.
    const lost = s.unknowns[0]!.claim.container;
    for (const store of [f.store, new Store(f.store.path)]) {
      if (store !== f.store) t.after(() => store.close());
      await still(store, async () => assert.deepEqual(await ask(valid, 'p', 'discovery', store), summary));
      const get = store.get;
      store.get = ((id: string, rev?: number) => id === lost.id ? null : get.call(store, id, rev)) as typeof store.get;
      try { await still(store, () => ask(valid, 'p', 'discovery', store), true); }
      finally { delete (store as any).get; }
    }
  });
});
const carrierPart = (saved: ReturnType<typeof produceSelectedDossier>, key: 'decision' | 'scope' | 'plan'): Ref => saved.record.value[key];

test('8.8 dossier summary: genuine no_variants partial names its reason and rejected material without an invented scope; imitation refuses', async t => {
  const f = await paid(t, (snapshot: Ref) => ({ action: 'no_variants', reasons: [{ code: 'bounded_search',
    message: 'No bounded variant', grounds: [snapshot] }], searchLimits: ['Saved sweep only'], unknowns: ['Demand unknown'] }), true);
  const none = f.store.list<VariantNone>('discovery-variant-none')[0]!; assert.ok(none);
  const handoff = await publishVariantHandoff(f.store, 'p', { draft: reference(f.store.get(f.draft.id)!),
    result: reference(none), decision: null, scope: null, earlyLimit: false });
  const saved = await producePartialDossier(f.store, 'p', reference(handoff.record)), root = reference(saved.record);
  const summary = (await still(f.store, () => summarize(f.store, root)))!, s = summary.snapshot;
  const reason = saved.record.value.reasons[0]!;
  assert.deepEqual(s.root, { kind: 'partial', ref: root });
  assert.equal(s.completeness, 'partial'); assert.deepEqual(s.manifest, root);
  assert.deepEqual(s.basis, { draft: saved.record.value.draft, frame: saved.record.value.frame, plan: saved.record.value.plan });
  assert.deepEqual(s.partial!.reasons.map(row => [row.index, row.code, row.message, row.grounds]), [[0, 'no_variants', reason.message, reason.grounds.length]]);
  assert.deepEqual(s.partial!.reasons[0]!.address, { record: root, pointer: '/reasons/0' });
  assert.equal(resolve(f.store, s.partial!.reasons[0]!.address).code, 'no_variants');
  // No variant was ever chosen: coverage, scope, set, member and decision stay absent instead of being invented.
  assert.equal(s.coverage, null);
  assert.deepEqual([s.route.scope, s.route.set, s.route.member, s.route.decision], [null, null, null, null]);
  assert.deepEqual(s.route.handoff, reference(handoff.record)); assert.deepEqual(s.route.result, reference(none));
  assert.ok(s.route.snapshot); assert.equal(s.stop, null);
  assert.ok(s.materials.rejected >= 1);
  const material = (await readPartialDossier(f.store, 'p', root)).materials;
  assert.deepEqual(s.materials, { accepted: countOf(material, 'accepted'), rejected: countOf(material, 'rejected'), unassessed: countOf(material, 'unassessed') });
  assert.deepEqual(s.next.map(step => step.action), ['return-partial-reason', 'assess-dossier']);
  assert.deepEqual(s.next[0]!.address, { kind: 'record', ...s.partial!.reasons[0]!.address });
  assert.ok(s.next[0]!.text.startsWith('no_variants'));
  const text = renderStageSummary(summary);
  for (const piece of ['частичный (partial)', 'Причина partial', reason.message, 'no_variants', refText(handoff.record ? reference(handoff.record) : root), refText(root)])
    assert.ok(text.includes(piece), piece);
  assert.doesNotMatch(text, /полный снимок \(complete\)/);
  assertAwaiting(summary, text);
  assert.deepEqual(jsonOf(summary), summary);
  // An honest-hash imitation with another reason is only structural, so the summary refuses it.
  const value: DossierManifest = structuredClone(saved.record.value); value.reasons[0]!.code = 'stall';
  const projected = projectDossierManifest(value);
  const fake = f.store.write({ id: projected.id, kind: DOSSIER_MANIFEST_KIND, expected: 0, value: projected.value });
  await still(f.store, () => summarize(f.store, reference(fake)), true);
  // Historical: the same partial summary after a new mode and a new accepted plan edition, hot and cold, with no head discovery.
  modeOf(f.store, 'bypass'); nextPlan(f, f.store);
  await fixed(f, f.store, async () => {
    for (const store of [f.store, new Store(f.store.path)]) {
      if (store !== f.store) t.after(() => store.close());
      await still(store, async () => assert.deepEqual(await summarize(store, root), summary));
    }
    const cold = new Store(f.store.path); t.after(() => cold.close());
    cold.list = (() => assert.fail('A historical summary must not discover material from current heads')) as typeof cold.list;
    try { assert.deepEqual(await summarize(cold, root), summary); } finally { delete (cold as any).list; }
  });
  // The subject stays the exact historical one the dossier-assessment door proves.
  assert.equal((await prepareDossierAssessmentSubject(f.store, 'p', root)).subject.identity, s.subject);
});

// ---- the runner line: real stopped partial snapshots after a paid budget stop and after N-limit stalls ----
async function runnerSetup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')]) {
  const f = discoveryFixture(t, 'omg-88-');
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')), s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')), q=r.subject.question?.id??'probe';
let prior=[];try{prior=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line))}catch{}
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research=s.actions?.[prior.filter(row=>!row.subject.assessmentSubject&&!row.subject.variantSubject).length]??{action:'answer',question:q,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=q;
if(r.subject.subject?.contract==='v7-plan-subject/v1'&&!r.subject.deepPreparation){
 const at=r.subject.subject,id=at.planQuestionId;
 research={action:'answer',question:id,value:{type:'submitted',contract:'discovery-claims/v7',value:{claims:[{id:'broad-'+prior.length,kind:'hypothesis',text:'Common sweep material '+prior.length,axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:at.planAnswer,planQuestionId:id}],scope:{variants:'common'},basis:{howToVerify:'Measure the common domain'}}]}},citations:[]};
}
if(r.subject.deepPreparation){
 const cell=r.subject.deepCell, id=cell.subject.planQuestionId;
 const claim={id:'deep-'+prior.length,kind:'hypothesis',text:'Exact variant material '+prior.length,axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:cell.subject.planAnswer,planQuestionId:id}],scope:{variants:s.deepMode==='common'?'common':[cell.variant.member]},basis:{howToVerify:'Measure the exact chosen variant'}};
 const claims=s.deepClaims??[claim];
 research={action:'answer',question:id,value:s.deepMode==='impossible'?{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'}:{type:'submitted',contract:'discovery-claims/v7',value:{claims}},citations:[]};
}
if(r.subject.variantSubject?.kind==='decision')research=s.reject?{action:'reject_all',reason:'Model rejects this exact set'}:{action:'choose',key:'v1',reason:'Model chooses the bounded member'};
else if(r.subject.variantSubject){
 const grounds=[r.subject.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];
 research=s.none?{action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds}],searchLimits:['Saved sweep only'],unknowns:['Demand unknown']}
 :{action:'variants',variants:[{key:'v1',title:'Bounded variant',proposal:{bounded:true},criteria:Object.fromEntries(keys.map(key=>[key,{conclusion:'Bounded model proposal',grounds,assumptions:[],unknowns:['Demand unknown'],quantity:null}]))}],scale:Object.fromEntries(keys.map(key=>[key,'Same bounded scale'])),comparison:'One bounded option',recommendation:{key:'v1',reason:'Only bounded candidate'},searchLimits:['Saved sweep only'],unknowns:['Demand unknown']};
}
if(r.subject.role==='reader'){if(s.readerFail)process.exit(42);research={selections:r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]})),unresolved:[]}};
if(r.subject.assessmentSubject){
 const entries=r.subject.assessmentSubject.packet.entries;
 const all=r.subject.value.attempts.flatMap(row=>row.end.type==='submitted'?row.end.value.claims.map((claim,index)=>({accepted:!claim.id.startsWith('counter'),claim:{project:r.subject.assessmentSubject.packet.project,container:row.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id}})):[]);
 const accepted=all.filter(c=>c.accepted).map(c=>({claim:c.claim,reason:'Supported exact hypothesis or addressed unknown'}));
 research={verdict:'supported',reasons:['Exact material classification'],return:null,novelty:{attempts:entries.map(e=>({attempt:e.attempt,reason:'Exact attempt'})),accepted,rejected:all.filter(c=>!c.accepted).map(c=>({claim:c.claim,reason:'Counterargument not supported'})),newContent:accepted,duplicates:[],noProgress:entries.filter(e=>!accepted.some(c=>c.claim.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No accepted addition'})),transition:accepted.length&&s.close!==false?{outcome:'closed',bases:accepted.map(c=>({claim:c.claim})),reason:'The exact criterion has enough supported material',sufficiency:{criterion:'Named basis answering '+r.subject.assessmentSubject.packet.planQuestionId,requiredDepth:'deep',reason:'Required depth is met',methodologyRequirements:[]}}:accepted.length&&s.outcome?{outcome:s.outcome,bases:accepted.map(c=>({claim:c.claim})),reason:'Reopened by the applied assessment',...(s.outcome==='unknown'?{consequence:'The deep cell stays missing',nextAction:'Find the named evidence'}:{})}:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):r.subject.deepPreparation?(s.deepTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, 'p', questions);
  function mode(value: 'questions' | 'bypass', store = f.store) {
    const request = { project: 'p', mode: value, previous: store.get('project-mode:p') ? reference(store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(store), invitation = issueProjectModeInvitation(store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const initial = mode('questions'), cal = f.store.write({ id: 'variant-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
  for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
    { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? { snapshot: reference(cal) } : { set: reference(cal) }), mode: reference(initial), expectedSelection: null }, history: [] }, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  writeFileSync(wire, '');
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const open = (store = f.store) => new Store(store.path);
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const nextEdition = (store = f.store) => {
    const discovery = new Discovery(store), engine = new ProductEngine(store);
    const plan = store.get<Question>(v.plan.id)!; discovery.reopen(plan.id, plan.revision);
    const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(v.draft.id)!;
    const source = discovery.evidence.document('p', 'edition-two', 'New accepted edition', 'text/plain', 0);
    answerDiscoveryFixture(engine, 'p', draft, question, validPlan(v.frameRef, questions, 2, v.planAnswer), source);
    return store.get<Question>(plan.id)!.value.answer!;
  };
  return { ...f, v, environment, run, wires, configure, mode, nextEdition, open };
}
function runnerChoiceScope(f: Awaited<ReturnType<typeof runnerSetup>>): VariantChoiceScope {
  const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  const set = f.store.get<VariantSet>(state.value.set!.id, state.value.set!.revision)!;
  return { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set),
    mode: reference(f.store.get('project-mode:p')!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'Authorized owner chooses the member' } };
}
function runnerOwner(store: Store, scope: VariantChoiceScope) {
  const sessions = new VariantChoiceSessions(store), issued = issueVariantChoiceInvitation(store, scope);
  assert.ok(issued.ok); if (!issued.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
  assert.ok(login.ok); if (!login.ok) assert.fail('Expected successful owner exchange');
  const act = answerVariantChoice(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok); return act;
}
async function ready(t: test.TestContext, config: Record<string, unknown> = {}) {
  const f = await runnerSetup(t);
  const generated = await f.run(3);
  assert.equal(generated.value.pauseCode, 'research_variant_owner_required', generated.value.error!);
  f.configure(config);
  runnerOwner(f.store, runnerChoiceScope(f));
  const pending = await f.run(1, f.store, true), details = JSON.parse(pending.value.error!);
  assert.equal(pending.value.pauseCode, 'research_deep_frontier_pending', pending.value.error!);
  const handoff = (await readVariantHandoff(f.store, 'p', details.handoff)).record;
  assert.equal(handoff.value.next, 'deep'); assert.deepEqual(handoff.value.scope, details.scope);
  assert.deepEqual(reference(readVariantScope(f.store, 'p', details.scope).scope), details.scope);
  return { ...f, scope: details.scope, pending };
}
type ReadyWorld = Awaited<ReturnType<typeof ready>>;
/** The one producer-built stopped-run world — calibrated runner, real sweep,
 * owner choice and the deep frontier pending — byte-forked per stop kind:
 * the budget stop and the stall stop are different continuations of the same
 * real shared past, each on its own isolated store copy. */
let readyBase: ReadyWorld | null = null, readySettings = '';
async function stoppedWorld(t: test.TestContext): Promise<ReadyWorld> {
  if (!readyBase) {
    readyBase = await ready(baseT);
    readySettings = readFileSync(join(readyBase.root, 'settings.json'), 'utf8');
  }
  // The adapter path is baked into the saved environment, so every fork keeps
  // the shared settings file — but it is restored to the base bytes first, so
  // no earlier test's configure() patch (e.g. a low token ceiling) bleeds in.
  writeFileSync(join(readyBase.root, 'settings.json'), readySettings);
  const store = forkStore(t, readyBase.store);
  return { ...readyBase, store, open: (s: Store = store) => new Store(s.path) };
}
/** What the summary of a stopped partial must show, taken from the saved stop and the saved manifest, never recomputed. */
async function expectStop(store: Store, details: { stop: Ref; dossier: Ref; handoff: Ref; scope: Ref }, summary: DossierSnapshotStageSummary, reason: 'budget' | 'stall') {
  const proof = await readDeepFrontierStop(store, 'p', details.stop), saved = proof.record.value, s = summary.snapshot;
  const partial = await readPartialDossier(store, 'p', details.dossier);
  assert.equal(saved.reason, reason);
  assert.deepEqual(s.root, { kind: 'partial', ref: details.dossier }); assert.equal(s.completeness, 'partial');
  assert.deepEqual(s.basis, { draft: saved.draft, frame: saved.frame, plan: saved.plan });
  assert.deepEqual(s.route.handoff, details.handoff); assert.deepEqual(s.route.scope, details.scope);
  assert.deepEqual([s.route.set, s.route.member, s.route.decision], [saved.set, saved.member, saved.decision]);
  assert.deepEqual(s.coverage, { cells: proof.coverage.cells.length, missing: proof.coverage.missing.length });
  assert.deepEqual(s.materials, { accepted: countOf(partial.materials, 'accepted'), rejected: countOf(partial.materials, 'rejected'), unassessed: countOf(partial.materials, 'unassessed') });
  const stop = s.stop!;
  assert.ok(stop);
  assert.deepEqual([stop.record, stop.reason, stop.run, stop.boundary], [details.stop, reason, saved.run, saved.boundary]);
  assert.deepEqual(s.partial!.reasons[0]!.code, reason);
  assert.deepEqual(s.partial!.reasons[0]!.address, { record: s.manifest, pointer: '/reasons/0' });
  assert.equal(resolve(store, s.partial!.reasons[0]!.address).code, reason);
  // Every missing cell the stop saved, in its saved order, with an address into the stop record itself.
  assert.deepEqual(stop.missing.map(cell => cell.key), saved.missing);
  stop.missing.forEach((cell, index) => {
    assert.deepEqual(cell.address, { record: details.stop, pointer: `/missing/${index}` });
    assert.equal(resolve(store, cell.address), cell.key);
    const proven = proof.coverage.missing.find(row => row.key === cell.key)!;
    assert.deepEqual([cell.planQuestionId, cell.requiredDepth, cell.criterion, cell.code, cell.message],
      [proven.cell.subject.planQuestionId, proven.cell.requiredDepth, proven.cell.criterion, proven.missing!.code, proven.missing!.message]);
  });
  // The progress counters (P/N) of every state the stop fixed, read through their own exact records.
  assert.deepEqual(stop.progress.map(row => row.state), saved.states);
  for (const row of stop.progress) {
    const summaryAt = resolve(store, row.address);
    assert.deepEqual([row.count, row.streak, row.outcome, row.reason, row.nextAction],
      [summaryAt.count, summaryAt.streak, summaryAt.outcome, summaryAt.reason, summaryAt.nextAction]);
    assert.equal(resolve(store, { record: row.state, pointer: '/subject/planQuestionId' }), row.planQuestionId);
  }
  // The stage accounting exactly as the stop fixed it at its boundary.
  assert.deepEqual(stop.budget, { segment: saved.budget.segment, ledger: saved.budget.ledger, calls: saved.budget.calls, measured: saved.budget.measured,
    reserved: saved.budget.reserved, remaining: saved.budget.remaining, overrun: saved.budget.overrun, exhausted: saved.budget.exhausted });
  if (reason === 'budget') assert.equal(stop.budget.exhausted, true);
  // Next actions keep every return address and each one resolves to the exact saved piece it names.
  const actions = s.next.map(step => step.action);
  assert.equal(actions[0], 'return-partial-reason'); assert.equal(actions.at(-1), 'assess-dossier');
  assert.equal(actions.filter(action => action === 'complete-missing-cell').length, stop.missing.length);
  assert.deepEqual(s.next.filter(step => step.action === 'complete-missing-cell').map(step => step.address), stop.missing.map(cell => ({ kind: 'record', ...cell.address })));
  assert.equal(actions.filter(action => action === 'follow-progress-action').length, stop.progress.filter(row => row.nextAction).length);
  for (const step of s.next) assert.notEqual(resolveNext(store, step.address), undefined);
  const text = renderStageSummary(summary);
  for (const piece of ['Остановка после выбора', refText(details.stop), 'Недостающие ячейки', 'Счётчики P/N на границе', 'Учёт бюджета на границе',
    `Граница: событие ${saved.boundary.sequence}`, ...stop.missing.map(cell => cell.planQuestionId), refText(details.dossier)])
    assert.ok(text.includes(piece), piece);
  assert.match(text, new RegExp(`причина ${reason}`));
  assertAwaiting(summary, text);
  assert.deepEqual(jsonOf(summary), summary);
  return { proof, text };
}

test('8.8 dossier summary: owner choice stopped by the paid budget keeps its missing cell, progress counters and accounting at the stop boundary', async t => {
  const f = await stoppedWorld(t);
  f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
  const result = await f.run(2, f.store), details = JSON.parse(result.value.error!);
  assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', result.value.error!);
  const root = details.dossier as Ref;
  const summary = (await still(f.store, () => summarize(f.store, root)))!;
  const { proof, text } = await expectStop(f.store, details, summary, 'budget');
  assert.deepEqual(summary.snapshot.stop!.missing.map(cell => cell.planQuestionId), ['q-two']);
  assert.equal(proof.coverage.missing.length, 1);
  assert.equal(summary.snapshot.stop!.budget.exhausted, true);
  assert.match(text, /исчерпан да/);
  // Historical hot/cold: a new mode and a new accepted plan edition change today's heads, not the saved stopped snapshot.
  t.diagnostic(`budget stop P/N: ${JSON.stringify(summary.snapshot.stop!.progress.map(row => [row.planQuestionId, row.count, row.streak, row.outcome]))}`);
  f.nextEdition(f.store); f.mode('bypass', f.store);
  await fixed(f, f.store, async () => {
    for (const store of [f.store, f.open()]) await still(store, async () => {
      assert.deepEqual(await summarize(store, root), summary);
      assert.equal(renderStageSummary(await summarize(store, root)), text);
      assert.deepEqual(await f.run(9, store), result);
    });
  });
});

test('8.8 dossier summary: stalled N limits keep every missing cell and its progress counters; the stalled snapshot is not a budget stop', async t => {
  const f = await stoppedWorld(t);
  f.configure({ deepMode: 'impossible' });
  await f.run(5, f.store);
  const result = await f.run(1, f.open()), details = JSON.parse(result.value.error!);
  assert.equal(result.value.pauseCode, 'research_dossier_assessment_unavailable', result.value.error!);
  const root = details.dossier as Ref;
  const { summary, proof } = await fixed(f, f.store, async () => {
    const summary = (await still(f.store, () => summarize(f.store, root)))!;
    const proof = (await expectStop(f.store, details, summary, 'stall')).proof;
    // The stopped summary answers with the stop's own reason and its own refusal of foreign and neighbouring Refs.
    for (const root2 of [details.stop, details.handoff, details.scope, { ...root, hash: '0'.repeat(64) }])
      await still(f.store, () => summarize(f.store, root2), true);
    await still(f.store, () => summarize(f.store, root, 'foreign'), true);
    return { summary, proof };
  });
  const stop = summary.snapshot.stop!;
  assert.equal(proof.coverage.missing.length, 2);
  assert.deepEqual(stop.missing.map(cell => cell.planQuestionId).sort(), ['q-one', 'q-two']);
  assert.ok(stop.progress.length >= 2);
  // Each missing cell stopped on its own N limit: the P-state of its question counted three attempts in a row without new content.
  for (const cell of stop.missing) {
    const row = stop.progress.find(item => item.planQuestionId === cell.planQuestionId)!;
    assert.ok(row, cell.planQuestionId); assert.ok(row.streak >= 3, `N=${row.streak}`);
  }
  t.diagnostic(`stall stop P/N: ${JSON.stringify(stop.progress.map(row => [row.planQuestionId, row.count, row.streak, row.outcome]))}`);
  assert.equal(stop.budget.exhausted, false);
  f.nextEdition(f.store); f.mode('bypass', f.store);
  await fixed(f, f.store, async () => {
    const cold = f.open();
    await still(cold, async () => assert.deepEqual(await summarize(cold, root), summary));
  });
});
