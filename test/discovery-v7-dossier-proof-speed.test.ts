import { fixtureApplicableAxes } from './discovery-v7-fixture.js';
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import { Store, storeReads, type Revision } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import type { ResearchRun, PaidDiscoveryAttemptsAssessment, DossierAssessmentPacket } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet, type VariantNone } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import type { OmResult } from '../src/om/refusal.js';
import { DISCOVERY_DEEP_PREPARATION_CONTRACT, produceDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions, proveAttempt } from '../src/discovery/v7-plan-questions.js';
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { DISCOVERY_CLAIMS_CONTRACT, DISCOVERY_ACCEPTANCE_ACT_KIND, discoveryAcceptanceActId, type DiscoveryAcceptanceAct } from '../src/discovery/v7-contracts.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { historicalProofCounters, historicalTrace, pendingSnapshotView } from '../src/history/proofs.js';
import { captureView } from '../src/storage/store-view.js';
import { researchSetup, produce, rand, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';

/**
 * OMG-V7-DOSSIER-PROOF-SPEED. A dossier read proves the same exact paid assessment and the same exact attempt once per claim,
 * per cell and per material. Read on the genuine Store these two proofs are shared historical proofs (derived once per
 * operation, kept by the common rules, handed out as copies); read through any other source they are derived in place as
 * before. These tests use the real producers end to end: the chain of the 6.3–6.5 dossier files, a selected snapshot with
 * thirteen claims of two attempts, and a genuine nonempty partial.
 */

const ok = <T>(result: OmResult<T>): T => {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
};
const judgement = { conclusion: 'Bounded by the paid sweep', grounds: [], assumptions: [], unknowns: ['No evidence beyond the saved sweep'], quantity: null };
const criteria = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, judgement]));
const scale = Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'Same shared scale']));
const generation = () => ({ action: 'variants', variants: [1, 2].map(i => ({ key: `v${i}`, title: `Variant ${i}`, proposal: { scope: `scope-${i}` }, criteria })),
  scale, comparison: 'Two bounded variants on one scale', recommendation: { key: 'v2', reason: 'The generation recommends the wider one' },
  searchLimits: ['Only the saved sweep'], unknowns: [] });

/** The real paid line: two assessed plan questions, the variant snapshot, real project modes and the real paid generation. */
async function paid(t: TestContext, answer: unknown = generation(), withMaterial = false) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-proof-speed-' }), project = 'p', runs = new Map<string, string>();
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
  if (!found) return { ...g, project, saved, questions, reply, set: null, draft: reference(f.store.get<DiscoveryDraft>(f.v.draft.id)!), scope: null };
  const set = found, draft = set.value.draft, state1 = f.store.get<VariantState>(variantStateId(project, draft.id))!;
  const scope: VariantChoiceScope = { action: VARIANT_OWNER_ACTION, projectId: project, draft, set: reference(set), mode: reference(questions),
    operation: 'initial', previous: null, expectedSelection: reference(state1), outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'The exact paid set fits the owner goal' } };
  return { ...g, project, saved, questions, reply, set, draft, scope };
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

/** The selected world: the owner choice, the published scope and both plan cells deep-researched, assessed and applied. */
async function selectedWorld(t: TestContext) {
  const f = await paid(t);
  const act = answerVariantChoice(f.store, f.scope!, mint(f.store, f.scope!).authority);
  const scope = publishVariantScope(f.store, 'p', reference(act.decision)).scope;
  const world = { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
  const industry = await deep(world, 'q-industry', fixtureApplicableAxes(world.v.draft).flatMap(axis => Array.from({ length: 6 }, (_, i) => claim(world, 'q-industry', axis, `Exact ${axis} evidence ${i}`))));
  await assess(world, industry);
  const market = await deep(world, 'q-market', [claim(world, 'q-market', 'market', 'Market cell evidence')]);
  await assess(world, market);
  return world;
}
type Selected = Awaited<ReturnType<typeof selectedWorld>>;
function claim(f: Selected, question: string, axis: string, text: string): Json {
  return { id: `h-${rand()}`, kind: 'hypothesis', text, axis, planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }],
    scope: { variants: [f.scopeRecord.value.member] }, basis: { howToVerify: 'Observe the named exact variant' } } as unknown as Json;
}
async function deep(f: Selected, question: string, claims: Json[]) {
  const scope = f.scopeRecord;
  const planQuestion = provePlanQuestions(f.store, f.store.get<DiscoveryDraft>(scope.value.draft.id, scope.value.draft.revision)!, f.v.planAnswer)
    .find(item => item.planQuestionId === question)!.question as Record<string, Json>;
  const preparation: DeepPreparation = { contract: DISCOVERY_DEEP_PREPARATION_CONTRACT, cell: { contract: DISCOVERY_COVERAGE_CELL_CONTRACT,
    projectId: 'p', subject: { contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: f.v.planAnswer, planQuestionId: question },
    variant: { set: scope.value.set, member: scope.value.member }, requiredDepth: planQuestion.requiredDepth as string,
    criterion: planQuestion.criterion as string }, scope: reference(scope) };
  const record = produceDeepPreparation(f.store, 'p', preparation).record;
  const baseline = v7ProgressBaseline(f.store, { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: question }), state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  const owner = f.store.get<ResearchRun>(state.value.summary.cursor.run)!;
  f.reply({ action: 'answer', question, value: { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } }, citations: [] });
  const result = (await runDeepResearch(f.store, { projectId: 'p', deepPreparation: reference(record), environment: f.environment, owner: reference(owner) }))!;
  assert.ok(result.attempt);
  return { result, claims, question };
}
type Deep = Awaited<ReturnType<typeof deep>>;
async function assess(f: Selected, entry: Deep, outcome: 'closed' | 'unknown' = 'closed', apply = true) {
  const packet = projectAttemptPacket(f.store, { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: entry.question,
    entries: [{ attempt: reference(entry.result.attempt), binding: reference(entry.result.binding) }] });
  const rows: ClaimAddress[] = entry.claims.map((row: any, index) => ({ project: 'p', container: reference(entry.result.attempt),
    containerKind: 'research-attempt', pointer: `/claims/${index}`, claimId: row.id }));
  const transition = outcome === 'closed' ? { outcome, bases: rows.map(claim => ({ claim })), reason: 'Exact cell answered',
    sufficiency: { criterion: `Named basis answering ${entry.question}`, requiredDepth: 'deep', reason: 'Enough exact grounds', methodologyRequirements: [] } }
    : { outcome, bases: rows.map(claim => ({ claim })), reason: 'Reopened on new evidence', consequence: 'Await exact evidence', nextAction: 'Obtain the source' };
  f.reply({ verdict: 'supported', reasons: ['Real paid classification'], return: null,
    novelty: { attempts: [{ attempt: reference(entry.result.attempt), reason: 'Exact managed deep' }],
      accepted: rows.map(claim => ({ claim, reason: 'Own variant material' })), rejected: [],
      newContent: rows.map(claim => ({ claim, reason: 'New exact content' })), duplicates: [], noProgress: [], transition },
    methodology: { contract: 'assessment-methodology/v1', policy: outcome === 'closed' ? 'assessment-methodology-policy/v2' : 'assessment-methodology-policy/v1', facts: [] } });
  const mr = outcome === 'closed' ? await assessAttemptsWithRequirements(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root)
    : await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
  if (apply) applyDiscoveryAssessment(f.store, 'p', reference(mr));
  return mr;
}
/** The owner changes the chosen member, the mode changes and the plan is reopened with a new accepted edition: heads the old
 * snapshot must not depend on. */
function movedHeads(f: Selected) {
  const state = f.store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const changed: VariantChoiceScope = { ...f.scope!, mode: reference(f.store.get('project-mode:p')!),
    operation: f.store.get(state.value.decision!.id)!.kind === 'discovery-variant-model-decision' ? 'override' : 'revise',
    previous: state.value.decision!, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'Owner changes chosen member' } };
  answerVariantChoice(f.store, changed, mint(f.store, changed).authority);
  modeOf(f.store, 'bypass');
  const engine = new ProductEngine(f.store), discovery = new Discovery(f.store), plan = f.store.get<Question>(f.v.plan.id)!;
  discovery.reopen(plan.id, plan.revision);
  const question = f.store.get<Question>(plan.id)!, draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!;
  const source = discovery.evidence.document('p', 'deep-next-plan', 'Next accepted plan', 'text/plain', 0);
  const questions = provePlanQuestions(f.store, f.v.draft, f.v.planAnswer).map(item => item.question as unknown as PlanQuestion);
  answerDiscoveryFixture(engine, 'p', draft, question, validPlan(f.v.frameRef, questions, 2, f.v.planAnswer), source);
}

/** A Store over a copy of the world's database with the proof cache emptied: no kept proof, in memory or saved. `unshared`
 * reads it through a transparent trace, which is not the genuine Store — the proofs of this change are then derived in place,
 * exactly as before, while every other proof keeps its usual kept results. */
function emptyCache(f: { path: string }, t: TestContext, unshared = false): Store {
  const root = mkdtempSync(join(tmpdir(), 'omg-proof-speed-copy-')), path = join(root, 'state.sqlite');
  const source = new DatabaseSync(f.path, { readOnly: true });
  try { source.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); } finally { source.close(); }
  const db = new DatabaseSync(path);
  try { db.exec('DELETE FROM proof_links; DELETE FROM proof_cache; DELETE FROM proof_nodes'); } finally { db.close(); }
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return unshared ? historicalTrace(store) : store;
}
/** How often the records `ids` are read, by get and by history, while the action runs. */
async function countReads(ids: ReadonlySet<string>, action: () => unknown): Promise<number> {
  const { get, history } = Store.prototype;
  let reads = 0;
  Store.prototype.get = function (this: Store, id: string, revision?: number) { if (ids.has(id)) reads++; return get.call(this, id, revision); } as typeof Store.prototype.get;
  Store.prototype.history = function (this: Store, id: string) { if (ids.has(id)) reads++; return history.call(this, id); } as typeof Store.prototype.history;
  try { await action(); } finally { Store.prototype.get = get; Store.prototype.history = history; }
  return reads;
}
const refused = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;

/** One selected world serves the tests in file order: two read it, one moves the heads after the saved dossier, the last one moves
 * the head of the plan's act — each leaves what the next needs (the saved dossier's Ref and the records it names). The first test
 * that needs it builds it, inside its own time, and names the time; a test run alone builds it itself. The world lives until the
 * file ends. */
const cleanups: (() => void)[] = [];
after(() => { for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* the file is ending */ } } });
type Shared = Selected & { dossierRoot: Ref };
let shared: Promise<Shared> | undefined;
const sharedWorld = (t: TestContext): Promise<Shared> => (shared ??= (async () => {
  const started = Date.now();
  const built = await selectedWorld({ after: (cleanup: () => void) => { cleanups.push(cleanup); } } as unknown as TestContext);
  const world = Object.assign(built, { dossierRoot: reference(produceSelectedDossier(built.store, 'p', built.input).record) });
  t.diagnostic(`selected world built in ${Date.now() - started} ms, inside the first test that needed it`);
  return world;
})());

test('dossier proof speed: thirteen claims of two attempts prove each paid assessment once per read, never once per claim; the results equal the unshared derivation', async t => {
  const f = await sharedWorld(t), root = f.dossierRoot;
  const assessments = f.store.list<PaidDiscoveryAttemptsAssessment>('discovery-assessment').filter(row => row.value.projectId === 'p');
  assert.ok(assessments.length >= 3, 'the world holds several distinct paid assessments');
  // The evidence of an assessment is its paid session and application. One derivation reads it this often …
  const evidence = assessments.map(row => ({ ref: reference(row), ids: new Set([row.value.session.id, row.value.application.id]) }));
  let single = 0, singlePhysical = 0;
  for (const item of evidence) {
    const store = emptyCache(f, t), before = storeReads();
    // PROOF-SPEED (owner rule 08.10): on the genuine Store an applied assessment is read as written; the full derivation this
    // baseline counts is the one an opaque source still makes.
    const reads = await countReads(item.ids, () => readDiscoveryAssessment(captureView(store).view, 'p', item.ref));
    singlePhysical += storeReads() - before;
    assert.ok(reads > 0, 'a derivation reads the evidence of its assessment');
    single += reads;
  }
  // … and a whole dossier read on a Store with no kept proof, over thirteen claims, reads it at most a few derivations' worth —
  // each paid assessment is proved by the shared proof and by the application proof that names it, not once per claim.
  const every = new Set(evidence.flatMap(item => [...item.ids])), cold = emptyCache(f, t);
  let coldPacket!: DossierAssessmentPacket;
  const flushes = historicalProofCounters().flushes, physical = storeReads();
  const reads = await countReads(every, async () => { coldPacket = await prepareDossierAssessmentSubject(cold, 'p', root); });
  const coldPhysical = storeReads() - physical;
  t.diagnostic(`evidence reads: ${single} for one derivation of each of ${evidence.length} assessments, ${reads} for one cold dossier read over ${coldPacket.materials.length} claims; `
    + `Store reads: ${singlePhysical} for the derivations, ${coldPhysical} for the dossier read`);
  assert.ok(coldPacket.materials.length >= 13);
  assert.ok(reads <= 4 * single, `${reads} evidence reads in one cold dossier read against ${single} for one derivation of each assessment`);
  // Nothing else in the read proves again either: the whole of it costs a handful of derivations' worth of Store reads (here under
  // five, with the application and plan proofs it also needs), not a proof per claim (more than twenty before the proofs were shared).
  assert.ok(coldPhysical <= 8 * singlePhysical, `${coldPhysical} Store reads in one cold dossier read against ${singlePhysical} for one derivation of each assessment`);
  // The whole read is one synchronous area: what it proved is saved once, at its end, not once per proof.
  assert.ok(historicalProofCounters().flushes - flushes <= 2, 'the cold dossier read saves its proofs at the end of its one common area');
  // What the read proved is kept beyond it: the next read of one assessment, or of one attempt, on this Store goes back to none
  // of their records — a proof that read around its source would have been derived again.
  const attemptRef = coldPacket.materials[0]!.address.container;
  assert.equal(await countReads(evidence[0]!.ids, () => readDiscoveryAssessment(cold, 'p', evidence[0]!.ref)), 0);
  assert.equal(await countReads(new Set([attemptRef.id]), () => proveAttempt(cold, attemptRef)), 0);
  // The same read again on this Store costs a fraction of the first — everything it needs is kept — and answers the same; so do the
  // genuine Store of the world and a source that shares nothing.
  const again = storeReads();
  assert.deepEqual(await prepareDossierAssessmentSubject(cold, 'p', root), coldPacket);
  assert.ok(3 * (storeReads() - again) <= coldPhysical, `${storeReads() - again} Store reads in the repeated dossier read against ${coldPhysical} in the first`);
  assert.deepEqual(await prepareDossierAssessmentSubject(f.store, 'p', root), coldPacket);
  assert.deepEqual(await prepareDossierAssessmentSubject(emptyCache(f, t, true), 'p', root), coldPacket);
  // Each assessment and attempt alone: the shared proof and the unshared derivation return the very record.
  const plain = emptyCache(f, t, true);
  for (const row of assessments) {
    assert.deepEqual(readDiscoveryAssessment(cold, 'p', reference(row)), row);
    assert.deepEqual(readDiscoveryAssessment(plain, 'p', reference(row)), row);
  }
  for (const material of coldPacket.materials) {
    const container = material.address.container;
    assert.deepEqual(proveAttempt(cold, container), proveAttempt(plain, container));
  }
});

test('dossier proof speed: foreign project, Ref, hash, hidden record and substituted record are refused after a successful read', async t => {
  const f = await sharedWorld(t), root = f.dossierRoot;
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', root);
  const row = f.store.list<PaidDiscoveryAttemptsAssessment>('discovery-assessment').find(item => item.value.projectId === 'p')!, ref = reference(row);
  assert.deepEqual(readDiscoveryAssessment(f.store, 'p', ref), row);                    // proved and kept on the genuine Store
  const attemptRef = packet.materials[0]!.address.container;
  assert.ok(proveAttempt(f.store, attemptRef).claims!.length > 0);
  // Arguments that name another project, Ref, hash or nothing refuse with the typed refusal they always did.
  const invalid = refused('discovery_assessment_invalid');
  for (const [project, at] of [['other', ref], ['', ref], [5, ref], ['p', null], ['p', {}], ['p', { ...ref, hash: '0'.repeat(64) }],
    ['p', { ...ref, id: `${ref.id}x` }], ['p', { ...ref, revision: ref.revision + 1 }]] as unknown as [string, Ref][])
    assert.throws(() => readDiscoveryAssessment(f.store, project, at), invalid);
  for (const at of [null, {}, { ...attemptRef, hash: '0'.repeat(64) }, { ...attemptRef, id: `${attemptRef.id}x` }, { ...attemptRef, revision: attemptRef.revision + 1 }] as unknown as Ref[])
    assert.throws(() => proveAttempt(f.store, at), refused('attempt_invalid'));
  // A record another source hides refuses there — the paid session of an assessment, an attempt, the dossier read as a whole —
  // and the genuine Store, which proved them all before, keeps its proofs and keeps answering.
  const hidden = emptyCache(f, t), hide = new Set([row.value.session.id, attemptRef.id]), get = hidden.get;
  hidden.get = ((id: string, revision?: number) => hide.has(id) ? null : get.call(hidden, id, revision)) as typeof hidden.get;
  assert.throws(() => readDiscoveryAssessment(hidden, 'p', ref), EngineError);
  assert.throws(() => proveAttempt(hidden, attemptRef), refused('attempt_invalid'));
  await assert.rejects(prepareDossierAssessmentSubject(hidden, 'p', root), EngineError);
  delete (hidden as { get?: unknown }).get;
  assert.deepEqual(readDiscoveryAssessment(hidden, 'p', ref), row);                    // visible again, it proves again
  assert.deepEqual(readDiscoveryAssessment(f.store, 'p', ref), row);
  assert.deepEqual(await prepareDossierAssessmentSubject(f.store, 'p', root), packet);
  // A substituted record in an overlay: same id and revision, other content. The overlay is not the genuine Store, so nothing
  // proved there is offered to it, and nothing proved on it is offered back.
  const forged = { ...row, value: { ...row.value, comparison: 'substituted' } } as unknown as Revision<unknown>;
  assert.throws(() => readDiscoveryAssessment(pendingSnapshotView(f.store, [forged]), 'p', ref), invalid);
  assert.deepEqual(readDiscoveryAssessment(f.store, 'p', ref), row);
  assert.equal(hashJson(row.value as never), row.hash);
});

test('dossier proof speed: the old snapshot reads the same after a late assessment and moved heads, and a returned object a caller changed never reaches the next read', async t => {
  const f = await sharedWorld(t), root = f.dossierRoot;
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', root);
  const row = f.store.list<PaidDiscoveryAttemptsAssessment>('discovery-assessment').find(item => item.value.projectId === 'p')!, ref = reference(row);
  // A caller that changes what it was handed changes only its own copy.
  const first = readDiscoveryAssessment(f.store, 'p', ref);
  first.value.reasons.length = 0; (first.value as { projectId: string }).projectId = 'changed';
  const attemptRef = packet.materials[0]!.address.container, proof = proveAttempt(f.store, attemptRef);
  proof.claims!.length = 0; (proof.attempt.value as { project: string }).project = 'changed';
  assert.deepEqual(readDiscoveryAssessment(f.store, 'p', ref), row);
  assert.deepEqual(proveAttempt(f.store, attemptRef).claims!.length, packet.materials.filter(item => item.address.container.id === attemptRef.id).length);
  assert.equal(proveAttempt(f.store, attemptRef).attempt.value.project, 'p');
  // A late material, its paid classification and a moved plan: another snapshot, the old one exactly as it was.
  const late = await deep(f, 'q-market', [claim(f, 'q-market', 'market', 'New snapshot with later material')]);
  const mr = await assess(f, late, 'unknown', false), second = produceSelectedDossier(f.store, 'p', f.input);
  const other = await prepareDossierAssessmentSubject(f.store, 'p', reference(second.record));
  assert.notEqual(other.subject.identity, packet.subject.identity);
  applyDiscoveryAssessment(f.store, 'p', reference(mr)); movedHeads(f);
  assert.deepEqual(await prepareDossierAssessmentSubject(f.store, 'p', root), packet);
  assert.deepEqual(await prepareDossierAssessmentSubject(emptyCache(f, t), 'p', root), packet);
  assert.deepEqual(await prepareDossierAssessmentSubject(emptyCache(f, t, true), 'p', root), packet);
  assert.deepEqual(await prepareDossierAssessmentSubject(f.store, 'p', reference(second.record)), other);
});

test('dossier proof speed: a head the shared proofs read changes after a successful read — the next read proves again and refuses exactly as the unshared read does', async t => {
  const f = await sharedWorld(t), root = f.dossierRoot;
  const packet = await prepareDossierAssessmentSubject(f.store, 'p', root);
  const row = f.store.list<PaidDiscoveryAttemptsAssessment>('discovery-assessment').find(item => item.value.projectId === 'p')!, ref = reference(row);
  const attemptRef = packet.materials[0]!.address.container;
  const outcome = (read: () => unknown): { ok: true } | { refused: string } => {
    try { read(); return { ok: true }; } catch (error) { return { refused: error instanceof EngineError ? error.code : String(error) }; }
  };
  const shared = () => [outcome(() => readDiscoveryAssessment(f.store, 'p', ref)), outcome(() => proveAttempt(f.store, attemptRef))];
  const unshared = () => [outcome(() => readDiscoveryAssessment(historicalTrace(f.store), 'p', ref)), outcome(() => proveAttempt(historicalTrace(f.store), attemptRef))];
  assert.deepEqual(shared(), [{ ok: true }, { ok: true }]);                              // proved and kept
  assert.deepEqual(unshared(), [{ ok: true }, { ok: true }]);
  // Both proofs read the head of the accepted plan's act. It moves: the plan act loses the question it was accepted for.
  const act = f.store.get<DiscoveryAcceptanceAct>(discoveryAcceptanceActId('p', f.v.draft.id, 'plan', f.v.planAnswer))!;
  assert.equal(act.kind, DISCOVERY_ACCEPTANCE_ACT_KIND);
  f.store.write({ id: act.id, kind: act.kind, expected: act.revision, value: { ...act.value, questionAfter: null } });
  const after = shared();
  assert.deepEqual(after, unshared(), 'the kept proofs were proved again and answer as the unshared reads do');
  // PROOF-SPEED (owner rule 08.10): the applied assessment is history read as written — a later head does not reinterpret it;
  // the attempt proof, still derived, refuses on the moved head, and so does the dossier read.
  assert.deepEqual(after, [{ ok: true }, { refused: 'plan_questions_invalid' }], `the read after the change: ${JSON.stringify(after)}`);
  await assert.rejects(prepareDossierAssessmentSubject(f.store, 'p', root), EngineError);
});

test('dossier proof speed: a genuine nonempty partial reads the same cold, warm and over a source that shares nothing', async t => {
  const f = await paid(t, (snapshot: Ref) => ({ action: 'no_variants', reasons: [{ code: 'bounded_search', message: 'No bounded variant', grounds: [snapshot] }],
    searchLimits: ['Saved sweep'], unknowns: ['Demand unknown'] }), true);
  const none = f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const handoff = await publishVariantHandoff(f.store, 'p', { draft: reference(f.store.get(f.draft.id)!), result: reference(none), decision: null, scope: null, earlyLimit: false });
  const root = reference((await producePartialDossier(f.store, 'p', reference(handoff.record))).record);
  const cold = emptyCache(f, t), packet = await prepareDossierAssessmentSubject(cold, 'p', root);
  assert.equal(packet.manifest.value.completeness, 'partial');
  assert.ok(packet.materials.some(item => item.status === 'rejected'));
  assert.deepEqual(await prepareDossierAssessmentSubject(cold, 'p', root), packet);
  assert.deepEqual(await prepareDossierAssessmentSubject(f.store, 'p', root), packet);
  assert.deepEqual(await prepareDossierAssessmentSubject(emptyCache(f, t, true), 'p', root), packet);
});
