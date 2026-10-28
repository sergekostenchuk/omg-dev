import { fixtureApplicableAxes } from './discovery-v7-fixture.js';
import type { TestContext } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { storeRefused, storeUnchanged } from './store-unchanged.js';
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
import { V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';

/**
 * The producer preparation of the three dossier transport/result/projector files (6.4 transport, 6.4 result transport,
 * 6.5 projector), kept once. `paid`, `setup`, `complete` and their helpers are the real producers the three files repeated
 * byte for byte; what a scenario asserts stays in the scenario.
 *
 * `completed` is the one place that caches: the finished selected world of a route (owner or model) is built once per test
 * process, closed and made read-only, and every test plants its own copy. A copy has its own database file, its own adapter,
 * reply and wire files and its own Environment revision with the roles calibrated again, so no Store, engine, authority,
 * closure, file or process is shared between tests. The seed's records name the seed's directory — the Environment, the
 * calls and the requests it was paid under — and stay exact as history, never rewritten; only what runs after the copy
 * uses the test's own files.
 *
 * `unchanged`, `untouched` and `fixedPoint` are the proofs of silence a door owes: one real door per element inside a window of
 * the Store's change stamp (test/store-unchanged.ts), with the paid calls, their ledger and the wire unchanged; every head and
 * revision is compared once per declared historical fixed-point block. `costs` names, when a test ends, where its time went.
 */

export const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
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
export async function paid(t: TestContext, answer: unknown = generation(), withMaterial = false, brief?: string) {
  if (typeof t.diagnostic === 'function') costs(t);   // the seed builds its own world under a stand-in context that prints nothing
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-dossier-seed-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'Selected variant scope' });
  if (brief !== undefined) {
    assert.equal(typeof brief, 'string');
    const draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!;
    const question = draft.value.questions.map(id => f.store.get<Question>(id)!).find(row => row.value.spec.field === 'brief')!;
    assert.ok(question, 'the original brief needs its real question');
    const source = f.discovery.evidence.document(project, 'dossier-seed-original-brief', brief, 'text/plain', 0);
    f.discovery.fact(question.id, question.revision, reference(source), { kind: 'text-range', start: 0, end: brief.length });
  }
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
export const modeOf = (store: Store, mode: 'questions' | 'bypass') => {
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

export type Paid = Omit<Awaited<ReturnType<typeof paid>>, 'prepare'>;
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
export function nextPlan(f: Paid, store: Store) {
  const engine = new ProductEngine(store), discovery = new Discovery(store), plan = store.get<Question>(f.v.plan.id)!;
  discovery.reopen(plan.id, plan.revision);
  const question = store.get<Question>(plan.id)!, draft = store.get<DiscoveryDraft>(f.v.draft.id)!;
  const source = discovery.evidence.document('p', 'deep-next-plan', 'Next accepted plan', 'text/plain', 0);
  const questions = provePlanQuestions(store, f.v.draft, f.v.planAnswer).map(item => item.question as unknown as PlanQuestion);
  answerDiscoveryFixture(engine, 'p', draft, question, validPlan(f.v.frameRef, questions, 2, f.v.planAnswer), source);
  return store.get<Question>(plan.id)!.value.answer!;
}


/** The whole product history — every head and every revision — exactly as it is saved, read through its own read-only connection. */
export const all = (store: Store) => {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
    revisions: db.prepare('SELECT * FROM revisions ORDER BY entity_id,revision').all() } as never); }
  finally { db.close(); }
};

// ---- the proofs of silence: what a door may not do, checked cheaply per element and fully per block ----

/** What the proofs of silence cost in this process, so a test shows where its time went. */
const spent = { windows: 0, actionMs: 0, checkMs: 0, dumps: 0, dumpMs: 0, tables: [] as { label: string; rows: number; ms: number }[] };
const tracked = new WeakSet<object>();
/** Prints, when the test ends, what its proofs of silence cost: every table of doors, the windows and the full comparisons of fixedPoint. */
export function costs(t: TestContext): void {
  if (tracked.has(t)) return;
  tracked.add(t);
  const from = { ...spent, tables: spent.tables.length };
  t.after(() => {
    for (const table of spent.tables.slice(from.tables)) t.diagnostic(`dossier table ${table.label}: ${table.rows} rows, ${table.ms} ms`);
    t.diagnostic(`dossier proofs of silence: ${spent.windows - from.windows} windows (action ${spent.actionMs - from.actionMs} ms, `
      + `stamp+money+wire ${spent.checkMs - from.checkMs} ms), ${spent.dumps - from.dumps} full history comparisons (${spent.dumpMs - from.dumpMs} ms)`);
  });
}

/**
 * One checked door, one element: the real door runs on the real Store and the Store's change stamp, the paid calls with their
 * ledger and the wire are the same afterwards — also when the door refuses (`refuses`: an EngineError). The full heads and
 * revisions are not dumped here; a block that is a historical fixed point proves them once with fixedPoint().
 */
export async function unchanged<T>(f: Paid, store: Store, action: () => Promise<T>, refuses = false): Promise<T | undefined> {
  const started = performance.now(), calls = money(store), wires = f.wires(), ready = performance.now();
  let result: T | undefined;
  if (refuses) await storeRefused(store, action);
  else result = await storeUnchanged(store, action);
  const acted = performance.now();
  assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  spent.windows++; spent.actionMs += Math.round(acted - ready); spent.checkMs += Math.round(ready - started + performance.now() - acted);
  return result;
}
/** A table of doors of one class: each row refuses on its own through the real door, inside its own window; the row is named on failure. */
export async function untouched(f: Paid, store: Store, label: string, rows: readonly (() => Promise<unknown>)[], refuses = true): Promise<void> {
  assert.ok(rows.length > 0, 'a table of doors needs its rows');
  const started = performance.now();
  for (const [index, row] of rows.entries()) {
    try { await unchanged(f, store, row, refuses); }
    catch (error) { throw new Error(`${label}, row ${index} of ${rows.length}: ${(error as Error).message}`, { cause: error }); }
  }
  spent.tables.push({ label: `${label} (${store === f.store ? 'hot' : 'cold'})`, rows: rows.length, ms: Math.round(performance.now() - started) });
}
/**
 * A block that is a declared historical fixed point or read-only block: every head and revision, the paid calls with their
 * ledger and the wire are exactly the same after it, whatever its elements proved one by one.
 */
export async function fixedPoint(f: Paid, store: Store, block: () => Promise<void>): Promise<void> {
  const started = performance.now(), history = all(store), calls = money(store), wires = f.wires(), ready = performance.now();
  await block();
  const acted = performance.now();
  assert.equal(all(store), history); assert.deepEqual(money(store), calls); assert.deepEqual(f.wires(), wires);
  spent.dumps += 2; spent.dumpMs += Math.round(ready - started + performance.now() - acted);
}
async function setup(t: TestContext, model = false, brief?: string) {
  const f = await paid(t, undefined, false, brief);
  const decision = model ? await modelChoose(f) : selected(f).act.decision;
  const scope = publishVariantScope(f.store, 'p', reference(decision)).scope;
  return { ...f, scopeRecord: scope, input: { scope: reference(scope), plan: f.v.planAnswer } };
}
export type Selected = Omit<Awaited<ReturnType<typeof setup>>, 'prepare'>;
export function claim(f: Selected, question: string, axis: string, text: string, variants: 'common' | Ref[] = [f.scopeRecord.value.member]): Json {
  return { id: `h-${rand()}`, kind: 'hypothesis', text, axis,
    planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants },
    basis: { howToVerify: 'Observe the named exact variant' } } as unknown as Json;
}
export async function deep(f: Selected, question: string, claims: Json[]) {
  const preparation = produceDeepPreparation(f.store, 'p', inputFor(f, f.scopeRecord, question)).record;
  const subject = { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: question };
  const baseline = v7ProgressBaseline(f.store, subject), state = f.store.get<any>((baseline.state as { ref: Ref }).ref.id)!;
  const owner = f.store.get<ResearchRun>(state.value.summary.cursor.run)!;
  f.reply({ action: 'answer', question, value: { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims } }, citations: [] });
  const result = (await runDeepResearch(f.store, { projectId: 'p', deepPreparation: reference(preparation),
    environment: f.environment, owner: reference(owner) }))!;
  assert.ok(result.attempt); return { result, claims, question, preparation };
}
/** The part of a deep entry a scenario reads: the attempt and its binding, the claims it carried and the plan question. */
export interface Entry { result: { attempt: Revision<unknown>; binding: Revision<unknown> }; claims: Json[]; question: string }
export const addresses = (entry: Entry): ClaimAddress[] => entry.claims.map((row: any, index) => ({ project: 'p', container: reference(entry.result.attempt),
  containerKind: 'research-attempt', pointer: `/claims/${index}`, claimId: row.id }));
export async function assess(f: Selected, entry: Entry, outcome: 'closed' | 'open' | 'unknown' | 'rejected' | 'material' = 'closed', apply = true) {
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
export function revise(f: Selected, store = f.store) {
  const state = store.get<VariantState>(variantStateId('p', f.draft.id))!;
  const scope: VariantChoiceScope = { ...f.scope!, mode: reference(store.get('project-mode:p')!), operation: store.get(state.value.decision!.id)!.kind === 'discovery-variant-model-decision' ? 'override' : 'revise',
    previous: state.value.decision!, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: f.set!.value.members[1]!, reason: 'Owner changes chosen member' } };
  return answerVariantChoice(store, scope, mint(store, scope).authority);
}

// ---- seeds: the finished selected world of a route, built once per process, planted as an independent copy per test ----

export type Route = 'owner' | 'model';
/** The completed selected world: `setup` and `complete` done, before any dossier is produced, checked or projected. */
export type Completed = Selected & { entries: { industry: Entry; market: Entry } };

interface EntryData { attempt: Ref; binding: Ref; claims: Json[]; question: string }
/** Values and Refs only: nothing live (Store, engine, authority, closure, Map) is kept between tests. */
interface SeedData {
  adapter: string; settings: string; wire: string; prompt: string;
  v: { draft: Ref; plan: Ref; planAnswer: Ref; frameRef: Ref }; calibration: { draft: Ref; question: Ref };
  saved: Ref; questions: Ref; set: Ref | null; draft: Ref; state1: Ref; scope: VariantChoiceScope | null;
  scopeRecord: Ref; input: { scope: Ref; plan: Ref }; entries: { industry: EntryData; market: EntryData };
}
interface Seed { database: string; data: SeedData }

const seeds = new Map<string, Promise<Seed>>(), cleanups: (() => void)[] = [];
process.once('exit', () => { for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* the process is ending */ } } });

const entryData = (entry: Entry): EntryData => ({ attempt: reference(entry.result.attempt), binding: reference(entry.result.binding),
  claims: structuredClone(entry.claims), question: entry.question });

async function buildSeed(route: Route, brief?: string): Promise<Seed> {
  // The seed owns its root until the process ends: the callbacks the fixture registers for a test run at exit instead.
  const owner = { after: (cleanup: () => void) => { cleanups.push(cleanup); } } as unknown as TestContext;
  const f = await setup(owner, route === 'model', brief), entries = await complete(f);
  const data: SeedData = { adapter: readFileSync(join(f.root, 'adapter.mjs'), 'utf8'), settings: f.settings, wire: join(f.root, 'wire.ndjson'), prompt: f.prompt,
    v: { draft: reference(f.v.draft), plan: reference(f.v.plan), planAnswer: f.v.planAnswer, frameRef: f.v.frameRef },
    calibration: { draft: reference(f.calibration.draft), question: reference(f.calibration.question) },
    saved: reference(f.saved), questions: reference(f.questions), set: f.set ? reference(f.set) : null, draft: f.draft, state1: reference(f.state1),
    scope: f.scope === null ? null : structuredClone(f.scope), scopeRecord: reference(f.scopeRecord),
    input: { scope: f.input.scope, plan: f.input.plan }, entries: { industry: entryData(entries.industry), market: entryData(entries.market) } };
  f.store.close();
  // A copy is exact only when the whole seed is one checkpointed file that nobody opens again.
  if (existsSync(`${f.path}-wal`) || existsSync(`${f.path}-shm`)) throw new Error(`Dossier seed ${f.path} was not checkpointed`);
  chmodSync(f.path, 0o400);
  return { database: f.path, data: structuredClone(data) };
}

/** A completed selected world of the route: its own database copy, adapter, reply and wire files, Environment revision and Stores. */
const seedBuilder = hashJson(readFileSync(new URL(import.meta.url), 'utf8'));
export async function completed(t: TestContext, route: Route, brief?: string): Promise<Completed> {
  costs(t);
  const started = Date.now();
  const key = canonical({ builder: seedBuilder, route, brief: brief === undefined ? { present: false } : { present: true, text: brief } });
  let seed = seeds.get(key);
  const built = seed === undefined;
  if (!seed) { seed = buildSeed(route, brief); seeds.set(key, seed); seed.catch(() => seeds.delete(key)); }
  const ready = await seed, planted = Date.now(), world = await plant(t, ready);
  t.diagnostic(`dossier world ${route}: seed ${built ? `built in ${planted - started} ms` : 'reused'}, copy planted in ${Date.now() - planted} ms`);
  return world;
}

async function plant(t: TestContext, seed: Seed): Promise<Completed> {
  const data = structuredClone(seed.data);
  const root = mkdtempSync(join(tmpdir(), 'omg-dossier-copy-')), path = join(root, 'state.sqlite');
  copyFileSync(seed.database, path); chmodSync(path, 0o600);
  const stores: Store[] = [], open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  const exact = <T>(ref: Ref) => {
    const row = store.get<T>(ref.id, ref.revision);
    assert.ok(row && row.hash === ref.hash, `the copy keeps ${ref.id}@${ref.revision} exactly`);
    return row;
  };
  // The child's own files. The seed's script is rebound to them; the historical records keep naming the seed's.
  const settings = join(root, 'reply.json'), wire = join(root, 'wire.ndjson'), adapter = join(root, 'adapter.mjs');
  writeFileSync(settings, JSON.stringify({ tokens: 10 }));
  const script = data.adapter.replaceAll(JSON.stringify(data.settings), JSON.stringify(settings)).replaceAll(JSON.stringify(data.wire), JSON.stringify(wire));
  assert.ok(script.includes(JSON.stringify(settings)) && script.includes(JSON.stringify(wire)) && !script.includes(dirname(data.settings)),
    'the copy\'s adapter names only the copy\'s own reply and wire files');
  writeFileSync(adapter, script);
  // Standard environment preparation on the copy: a new Environment revision on the test's own workspace and adapter, and the
  // roles calibrated again — the estimate compares a role only with calls of the same command, so a new command starts unmeasured.
  const command = { executable: process.execPath, args: [adapter] };
  const previous = engine.environments.get('p'), { projectId: _projectId, ...kept } = previous.value;
  const environment = engine.environments.configure('p', { ...kept, workspace: root,
    implementer: { ...kept.implementer, command }, reviewer: { ...kept.reviewer, command }, fullCheck: command }, previous.revision);
  const calibration = { draft: exact<DiscoveryDraft>(data.calibration.draft), question: exact<Question>(data.calibration.question) };
  for (const purpose of ['analyst', 'assessor'] as const)
    await researchCall(environment.value[purpose === 'analyst' ? 'implementer' : 'reviewer'], environment.value, 'Calibrate', {}, undefined,
      { store, draftId: calibration.draft.id, questionId: calibration.question.id, purpose });
  const v = { draft: exact<DiscoveryDraft>(data.v.draft), plan: exact<Question>(data.v.plan), planAnswer: data.v.planAnswer, frameRef: data.v.frameRef };
  const entry = (item: EntryData): Entry => ({ result: { attempt: exact(item.attempt), binding: exact(item.binding) }, claims: item.claims, question: item.question });
  const world = { root, path, store, engine, discovery, open, v, project: 'p',
    subject: (id = 'q-industry', answer = v.planAnswer): V7PlanSubject => ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: answer, planQuestionId: id }),
    wires: () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    environment, prompt: data.prompt, settings, calibration,
    saved: exact(data.saved), questions: exact(data.questions), set: data.set ? exact<VariantSet>(data.set) : null, draft: data.draft,
    state1: exact<VariantState>(data.state1), scope: data.scope, reply: (value: unknown) => writeFileSync(settings, JSON.stringify({ tokens: 10, reply: value })),
    scopeRecord: exact(data.scopeRecord), input: data.input,
    entries: { industry: entry(data.entries.industry), market: entry(data.entries.market) } };
  return world as unknown as Completed;
}
