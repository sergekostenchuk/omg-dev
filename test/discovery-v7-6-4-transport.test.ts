import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeRefused } from './store-unchanged.js';
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
import { prepareDossierResearchEnvelope, prepareResearchEnvelope, researchCall } from '../src/discovery/research-protocol.js';
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
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { requireDossierTransportArchive } from '../src/discovery/continuation-packet.js';
import { archivedContext, contextPage, contextValue, workingContext } from '../src/discovery/working-context.js';
import { requirePacketMaterialDelivery } from '../src/discovery/research-delivery.js';

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
type Turnable = Awaited<ReturnType<typeof researchSetup>> & { runs: Map<string, string> };
function prepareTurn(f: Turnable, selected = f.subject()) {
    const project = 'p', runs = f.runs;
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
}
async function paid(t: { after(fn: () => void): void }, answer: unknown = generation(), withMaterial = false) {
  const base = await researchSetup(t as test.TestContext, { adapter: 'reply', prefix: 'omg-64-transport-' }), project = 'p';
  await base.engine.execute({ type: 'create-project', project, title: 'Selected variant scope' });
  const f = { ...base, runs: new Map<string, string>() } as Turnable;
  const g = { ...f, prepare: (selected = f.subject()) => prepareTurn(g, selected) };
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
/** A refusal inside a write-free block: the change stamp, money and wire stay; full dumps bound the block. */
async function refused(f: Paid, store: Store, action: () => Promise<unknown>) {
  const calls = money(store), wires = f.wires();
  await storeRefused(store, action);
  assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
}
async function unchanged<T>(f: Paid, store: Store, action: () => Promise<T>, refuses = false): Promise<T | undefined> {
  const before = all(store), calls = money(store), wires = f.wires();
  let result: T | undefined;
  if (refuses) await assert.rejects(action, error => error instanceof EngineError);
  else result = await action();
  assert.equal(all(store), before); assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  return result;
}
async function built(t: { after(fn: () => void): void }, model = false) {
  const f = await paid(t);
  const decision = model ? await modelChoose(f) : selected(f).act.decision;
  const scope = publishVariantScope(f.store, 'p', reference(decision)).scope;
  return { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
}
type Selected = Awaited<ReturnType<typeof built>>;
// A world is built once by the real producers; every test then restores its exact bytes in place (its records name the
// world's root) and opens Stores of its own. Tests of one file run one after another, so no test sees another's writes.
const worldRoots: string[] = [];
process.once('exit', () => { for (const root of worldRoots) rmSync(root, { recursive: true, force: true }); });
const WORLD_FILES = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'reply.json', 'wire.ndjson'];
const worlds = new Map<string, { world: Selected; snapshot: string; entries: unknown }>();
function rebind<T extends Selected>(t: test.TestContext, world: T): T {
  const stores: Store[] = [], open = () => { const db = new Store(world.path); stores.push(db); return db; };
  const store = open();
  t.after(() => { for (const db of stores) db.close(); });
  const g = { ...world, store, engine: new ProductEngine(store), discovery: new Discovery(store), open, runs: new Map(world.runs) } as T;
  (g as any).prepare = (selected = g.subject()) => prepareTurn(g as unknown as Turnable, selected);
  return g;
}
async function world<E>(t: test.TestContext, key: string, model: boolean, extend: (f: Selected) => Promise<E>,
  from?: string): Promise<Selected & { entries: E }> {
  let cached = worlds.get(key);
  if (!cached) {
    // A derived world continues the exact restored bytes of its base world in that world's own root.
    const closing: (() => void)[] = [], scratch = { after: (fn: () => void) => closing.push(fn) } as unknown as test.TestContext;
    const f = from ? await world(scratch, from, model, async () => null) : await built({ after: () => {} }, model), entries = await extend(f);
    if (!from) worldRoots.push(f.root);
    f.store.close(); for (const close of closing) close();
    const snapshot = mkdtempSync(join(tmpdir(), 'omg-64transport-snap-')); worldRoots.push(snapshot);
    for (const file of WORLD_FILES) if (existsSync(join(f.root, file))) copyFileSync(join(f.root, file), join(snapshot, file));
    cached = { world: f, snapshot, entries: structuredClone(entries) };
    worlds.set(key, cached);
  }
  for (const file of WORLD_FILES) {
    rmSync(join(cached.world.root, file), { force: true });
    if (existsSync(join(cached.snapshot, file))) copyFileSync(join(cached.snapshot, file), join(cached.world.root, file));
  }
  return { ...rebind(t, cached.world), entries: structuredClone(cached.entries) as E };
}
/** The selected owner/model world with both managed deep cells completed by the real producers. */
const completed = (t: test.TestContext, model = false) => world(t, model ? 'model-complete' : 'owner-complete', model, complete, model ? 'model' : 'owner');
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


const instruction = 'Prepare this exact saved dossier for assessment; preserve every status and contradiction.';
function audit(f: Paid, store = f.store) {
  return { store, draftId:f.draft.id, questionId:f.v.plan.id, purpose:'dossier-assessor' };
}
async function envelope(f: Paid, packet: Awaited<ReturnType<typeof prepareDossierAssessmentSubject>>,
  limit = 24000, store = f.store, context: unknown = { dossierSubject:packet.subject }, capacity?: Record<string,any>) {
  return prepareDossierResearchEnvelope(f.environment.value.reviewer, { ...f.environment.value, requestCapacityChars:limit },
    instruction, context, audit(f, store), capacity);
}
function verifyBytes(f: Paid, built: Awaited<ReturnType<typeof envelope>>, packet: Awaited<ReturnType<typeof prepareDossierAssessmentSubject>>,
  store = f.store) {
  const wire = JSON.parse(built.input), body = archivedContext(store, store.get<DiscoveryDraft>(f.draft.id)!, wire.subject.working.archive).body;
  assert.equal(canonical(wire), canonical({ ...built.envelope, subject:built.subject }));
  assert.ok(built.input.length <= built.requestLimit);
  assert.deepEqual(wire.subject.dossierSubject, packet.subject);
  assert.deepEqual(wire.subject.resultCapacity.bindings.dossierSubject, packet.subject);
  assert.equal(wire.subject.resultCapacity.purpose,'dossier-assessor');
  assert.equal(wire.subject.purpose,'dossier-assessor');
  assert.deepEqual(wire.subject.resultCapacity.forms.map((form:any)=>form.kind),['read_context']);
  assert.equal(wire.subject.assessmentDelivery.dispatch,'unavailable');
  assert.equal(wire.subject.question,undefined); assert.equal(wire.subject.assessmentSubject,undefined);
  assert.deepEqual(body.dossierPacket,packet); assert.deepEqual(body.dossierSubject,packet.subject);
  requirePacketMaterialDelivery(wire.subject, wire.subject.working.archive,
    (record,pointer)=>contextValue(archivedContext(store,store.get<DiscoveryDraft>(f.draft.id)!,record),pointer));
  // Reassemble actual saved content by the ordinary canonical JSON page API.
  let encoded = '', offset = 0;
  do {
    const page = contextPage(body.dossierPacket,{offset,limit:271,encoding:'canonical-json'});
    encoded += page.value; offset = page.page!.next ?? -1;
  } while (offset !== -1);
  assert.deepEqual(JSON.parse(encoded),packet);
  if (!wire.subject.dossierPacket) {
    assert.ok(wire.subject.working.materialAddresses.some((a:any)=>a.field==='dossierPacket'));
    const delivered = wire.subject.materialDelivery[0];
    assert.equal(delivered.original.pointer,'/body/dossierPacket');
    assert.ok(delivered.served.end > delivered.served.offset);
    assert.ok(delivered.served.next !== null);
    assert.equal(delivered.text,canonical(packet).slice(delivered.served.offset,delivered.served.end));
  }
  return wire;
}

for (const model of [false,true])
test(`6.4 transport: real ${model ? 'model' : 'owner'} selected -> common capacity/archive/envelope; bounded full bytes and historical cold identity`,async t=>{
  const f = await completed(t,model);
  const saved = produceSelectedDossier(f.store,'p',f.input);
  const packet = await prepareDossierAssessmentSubject(f.store,'p',reference(saved.record));
  const before = money(f.store), wires=f.wires();
  const built = await envelope(f,packet); verifyBytes(f,built,packet);
  assert.deepEqual(money(f.store),before); assert.deepEqual(f.wires(),wires);
  await unchanged(f,f.store,async()=>assert.equal((await envelope(f,packet)).input,built.input));
  assert.deepEqual(await requireDossierTransportArchive(f.store,'p',built.subject.working.archive,packet.subject),packet);
  const late = await deep(f,'q-market',[claim(f,'q-market','market','Later material belongs to another exact snapshot')]);
  const mr = await assess(f,late,'unknown',false);
  const second = produceSelectedDossier(f.store,'p',f.input);
  const other = await prepareDossierAssessmentSubject(f.store,'p',reference(second.record));
  assert.notEqual(other.subject.identity,packet.subject.identity);
  const next = await envelope(f,other); verifyBytes(f,next,other);
  assert.notDeepEqual(next.subject.working.archive,built.subject.working.archive);
  await unchanged(f,f.store,()=>envelope(f,other,24000,f.store,undefined,built.subject.resultCapacity),true);
  applyDiscoveryAssessment(f.store,'p',reference(mr)); revise(f); modeOf(f.store,model?'questions':'bypass'); nextPlan(f,f.store);
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    await unchanged(f,store,async()=>assert.deepEqual(await requireDossierTransportArchive(store,'p',built.subject.working.archive,packet.subject),packet));
    const hot=await envelope(f,packet,24000,store); verifyBytes(f,hot,packet,store);
    await unchanged(f,store,async()=>assert.equal((await envelope(f,packet,24000,store)).input,hot.input));
  }
});

test('6.4 transport: rejected, unassessed, unknown and both relation sides are exact; missing/mixed/substituted and raw dispatch refuse without effects',async t=>{
  const f=await completed(t); const entries=f.entries, target=addresses(entries.industry)[0]!;
  const contrary={...(claim(f,'q-market','market','Retained rejected counterargument') as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json;
  const rejected=await deep(f,'q-market',[contrary]);await assess(f,rejected,'rejected');
  const unknown={...(claim(f,'q-market','market','Retained unassessed unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved gap',unknownId:'transport-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json;
  await deep(f,'q-market',[unknown]);
  const saved=produceSelectedDossier(f.store,'p',f.input);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(saved.record));
  const built=await envelope(f,packet),wire=verifyBytes(f,built,packet);
  assert.ok(packet.materials.some(m=>m.status==='rejected'));assert.equal(packet.unknowns[0]!.material.status,'unassessed');
  assert.equal(packet.contradictions.length,2);assert.ok(packet.contradictions.every(c=>c.sides.length===2));
  const malformed: unknown[]=[null,{}, {dossierPacket:packet},{dossierSubject:null},{dossierSubject:{}},
    {dossierSubject:{...packet.subject,contract:'dossier-assessment-subject/v99'}},
    {dossierSubject:{...packet.subject,manifest:packet.subject.root.ref}},
    {dossierSubject:{...packet.subject,projectId:'foreign'}},
    {dossierSubject:packet.subject,assessmentDelivery:{dispatch:'available'}},
    {dossierSubject:packet.subject,purpose:'analyst'}, {dossierSubject:packet.subject,role:'analyst'},
    ...['subject','assessmentSubject','variantSubject','deepPreparation','assessmentState','question','responseContract']
      .map(key=>({dossierSubject:packet.subject,[key]:null}))];
  for (const field of Object.keys(packet.subject)) {
    const missing: any = structuredClone(packet.subject); delete missing[field];
    malformed.push({dossierSubject:missing},{dossierSubject:{...packet.subject,[field]:null}});
  }
  const truncated=structuredClone(packet);truncated.contradictions[0]!.sides.pop();
  for(const candidate of [ {...packet,materials:packet.materials.slice(1)}, {...packet,unknowns:[]},
    {...packet,contradictions:[]},truncated ])malformed.push({dossierSubject:packet.subject,dossierPacket:candidate});
  // Every malformed variant passes the main door hot; the cold Store keeps one representative of each distinct class
  // (context shape, packet substitution) beside every other distinct door. Full dumps bound the write-free blocks.
  const representatives=[malformed[0],malformed.at(-1)];
  for(const store of [f.store,new Store(f.store.path)]) {
    const hot=store===f.store;if(!hot)t.after(()=>store.close());
    const refuse=(action:()=>Promise<unknown>)=>refused(f,store,action), dumped=all(store);
    for(const context of hot?malformed:representatives)await refuse(()=>envelope(f,packet,24000,store,context));
    if(hot)assert.equal(all(store),dumped);
    await refuse(()=>envelope(f,packet,600,store));
    await refuse(()=>envelope(f,packet,6000,store));
    const bad=structuredClone(wire.subject.resultCapacity);bad.bindings.dossierSubject={...packet.subject,identity:'foreign'};
    await refuse(()=>envelope(f,packet,24000,store,{dossierSubject:packet.subject,resultCapacity:bad}));
    await refuse(()=>envelope(f,packet,24000,store,undefined,bad));
    await refuse(async()=>prepareResearchEnvelope(f.environment.value.reviewer,f.environment.value,instruction,
      {dossierSubject:packet.subject},audit(f,store)));
    await refuse(async()=>workingContext(store,'p',f.draft.id,f.v.plan.id,{dossierSubject:packet.subject},24000));
    for(const context of [{dossierSubject:packet.subject},{dossierSubject:null},{resultCapacity:wire.subject.resultCapacity}])
      await refuse(()=>researchCall(f.environment.value.reviewer,f.environment.value,instruction,context,undefined,audit(f,store)));
    await refuse(()=>researchCall(f.environment.value.reviewer,f.environment.value,instruction,{dossierSubject:packet.subject},undefined));
    await refuse(()=>researchCall(f.environment.value.reviewer,f.environment.value,instruction,{dossierSubject:packet.subject},undefined,{...audit(f,store),purpose:'assessor'}));
    // An honestly saved content-addressed archive still cannot substitute material.
    const original=store.get<any>(wire.subject.working.archive.id,1)!;
    const value=structuredClone(original.value);value.body.dossierPacket.contradictions[0].sides.pop();
    const id=`research-context:${hashJson(value)}`;
    const counterfeit=store.get(id) ?? store.write({id,kind:'research-context',expected:0,value});
    await refuse(()=>requireDossierTransportArchive(store,'p',reference(counterfeit),packet.subject));
    const bindingValue=structuredClone(original.value);bindingValue.body.resultCapacity.bindings.dossierSubject.identity='foreign';
    const bindingId=`research-context:${hashJson(bindingValue)}`;
    const wrongBinding=store.get(bindingId) ?? store.write({id:bindingId,kind:'research-context',expected:0,value:bindingValue});
    await refuse(()=>requireDossierTransportArchive(store,'p',reference(wrongBinding),packet.subject));
    await refuse(()=>requireDossierTransportArchive(store,'p',{...wire.subject.working.archive,hash:'0'.repeat(64)},packet.subject));
    // The cold pass finds both honestly saved counterfeits already present: its whole block writes nothing.
    if(!hot)assert.equal(all(store),dumped);
  }
});

test('6.4 transport: real nonempty no_variants partial carries reasons and rejected bytes through async preflight and bounded pages',async t=>{
  const f=await paid(t,(snapshot:Ref)=>({action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds:[snapshot]}],
    searchLimits:['Saved sweep'],unknowns:['Demand unknown']}),true);
  const none=f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const handoff=await publishVariantHandoff(f.store,'p',{draft:reference(f.store.get(f.draft.id)!),result:reference(none),decision:null,scope:null,earlyLimit:false});
  const saved=await producePartialDossier(f.store,'p',reference(handoff.record));
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(saved.record));
  const built=await envelope(f,packet);verifyBytes(f,built,packet);
  assert.equal(packet.manifest.value.completeness,'partial');assert.equal(packet.manifest.value.reasons[0]!.code,'no_variants');
  assert.ok(packet.materials.some(m=>m.status==='rejected'));assert.equal(packet.route.scope,null);
  const cut={...packet,manifest:{...packet.manifest,value:{...packet.manifest.value,reasons:[]}}};
  await unchanged(f,f.store,()=>envelope(f,packet,24000,f.store,{dossierSubject:packet.subject,dossierPacket:cut}),true);
  modeOf(f.store,'bypass');nextPlan(f,f.store);
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    await unchanged(f,store,async()=>assert.deepEqual(await requireDossierTransportArchive(store,'p',built.subject.working.archive,packet.subject),packet));
    const again=await envelope(f,packet,24000,store);verifyBytes(f,again,packet,store);
    await unchanged(f,store,async()=>assert.equal((await envelope(f,packet,24000,store)).input,again.input));
  }
});
