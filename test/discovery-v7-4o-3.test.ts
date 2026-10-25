import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/storage/store.js';
import { EngineError } from '../src/errors.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { readVariantModelDecision, runVariantSession, type VariantSessionInput } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantModelDecision,
  type VariantOwnerDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { answerVariantChoice, readVariantOwnerDecision } from '../src/discovery/discovery-decision.js';
import { issueVariantChoiceInvitation, VariantChoiceSessions, ProjectModeSessions, issueProjectModeInvitation,
  VARIANT_CHOICE_SESSION_PREFIX, type VariantChoiceSession } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

function ok<T>(result: { ok: true; value: T } | { ok: false; refusal: { code: string } }): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.refusal.code);
  return (result as { ok: true; value: T }).value;
}
const refuses = (invoke: () => unknown, code?: string) => assert.throws(invoke, (error: unknown) =>
  error instanceof EngineError && (!code || error.code === code));
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const money = (store: Store) => ({ calls: store.list('model-call').flatMap(row => store.history(row.id)),
  ledger: store.list('research-budget-ledger').flatMap(row => store.history(row.id)) });
const variantSessions = (store: Store) => store.list<VariantChoiceSession>('owner-session')
  .filter(row => row.id.startsWith(VARIANT_CHOICE_SESSION_PREFIX));
type CliOutcome = { decision: Ref; state: Ref; repeated: boolean };

const generation = () => ({ action: 'variants', variants: [{ key: 'one', title: 'One bounded variant', proposal: { scope: 'common' },
  criteria: Object.fromEntries(VARIANT_CRITERIA.map(key => [key, { conclusion: 'Bounded by the paid sweep', grounds: [], assumptions: [],
    unknowns: ['No evidence beyond the saved sweep'], quantity: null }])) }],
  scale: Object.fromEntries(VARIANT_CRITERIA.map(key => [key, 'Same shared scale'])), comparison: 'One bounded variant',
  recommendation: { key: 'one', reason: 'Fits the exact snapshot' }, searchLimits: ['Saved sweep'], unknowns: [] });
async function paid(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-4o3-paid-' }), project = 'p', runs = new Map<string, string>();
  await f.engine.execute({ type: 'create-project', project, title: 'CLI variant authority' });
  const prepare = (selected = f.subject()) => {
    const context = { history: [], readings: [] }, draft = f.store.get<DiscoveryDraft>(f.v.draft.id)!,
      question = f.store.get<Question>(f.v.plan.id)!;
    const old = runs.get(selected.planAnswer.hash), run = old ? f.store.get<ResearchRun>(old)! : f.store.write<ResearchRun>({
      id: `research-run:${rand()}`, kind: 'research-run', expected: 0, value: { projectId: project, draftId: draft.id,
        environment: reference(f.environment), turns: 0, limit: 100, requestChars: 0,
        owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null,
        status: 'running', inputs: draft.value.inputs } });
    runs.set(selected.planAnswer.hash, run.id); const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']),
      owner: reference(run), draft: reference(draft), question: reference(question), role: f.environment.value.implementer,
      dispatch: f.environment.value, profile: null, cursor: { run: run.id, turn: number, instruction: f.prompt, context, subject: selected },
      basis: draft.value.inputs, guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input), invoke = () => researchCall(f.environment.value.implementer,
      f.environment.value, f.prompt, context, undefined, { store: f.store, draftId: draft.id, questionId: question.id,
        purpose: 'analyst', consumerIntent: reference(intent), requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, input, invoke, question, draft, selected, context };
  };
  const g = { ...f, prepare };
  for (const question of ['q-industry', 'q-market']) {
    const entry = await produce(g, undefined, question), packet = projectAttemptPacket(f.store,
      { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [
      { attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: [], newContent: [], duplicates: [],
      noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null }, methodology: {
      contract: 'assessment-methodology/v1', policy: 'assessment-methodology-policy/v1', facts: [] } };
    writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
    const assessment = await assessAttempts(f.store, packet, v7ProgressBaseline(f.store, packet), f.environment, f.root);
    applyDiscoveryAssessment(f.store, project, reference(assessment));
  }
  const saved = produceVariantSnapshot(f.store, project).record;
  const modeSessions = new ProjectModeSessions(f.store), invite = ok(issueProjectModeInvitation(f.store,
    { project, mode: 'questions', previous: null }));
  const exchanged = ok(modeSessions.exchange({ project, invitation: invite.invitation }));
  const mode = setProjectMode(f.store, { project, mode: 'questions', previous: null },
    modeSessions.authority(exchanged.bearer)).record;
  ok(modeSessions.revoke(exchanged.bearer));
  const subject: VariantSubject = { contract: VARIANT_SUBJECT_CONTRACT, kind: 'proposal', snapshot: reference(saved),
    mode: reference(mode), expectedSelection: null };
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply: generation() }));
  // Explicit transport fixture only for service calibration; the positive producer below uses the real snapshot.
  const calibration = f.store.write({ id: 'transport-fixture:owner-variant-cli-calibration', kind: 'transport-fixture',
    expected: 0, value: { projectId: project } });
  await researchCall(f.environment.value.implementer, f.environment.value, 'Calibrate generation',
    { variantSubject: { ...subject, snapshot: reference(calibration) }, history: [] }, undefined,
    { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-proposal' });
  const receipt = await runVariantSession(f.store, { projectId: project, variantSubject: subject, environment: f.environment,
    role: f.environment.value.implementer, prompt: 'Propose variants from this exact paid sweep' });
  assert.equal(receipt.value.cursor, 1);
  const sets = f.store.list<VariantSet>('discovery-variant-set');
  assert.equal(sets.length, 1, 'the real paid set is published');
  const set = sets[0]!, state = f.store.get(variantStateId(project, f.v.draft.id))!;
  const scope: VariantChoiceScope = { action: VARIANT_OWNER_ACTION, projectId: project, draft: set.value.draft,
    set: reference(set), mode: reference(mode), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'The exact paid set fits the owner goal' } };
  return { ...g, scope, set, mode, receipt };
}
const modeOf = (store: Store, mode: 'questions' | 'bypass') => {
  const previous = store.get('project-mode:p'), scope = { project: 'p', mode, previous: previous ? reference(previous) : null };
  const sessions = new ProjectModeSessions(store), issued = ok(issueProjectModeInvitation(store, scope));
  const login = ok(sessions.exchange({ project: 'p', invitation: issued.invitation }));
  return setProjectMode(store, scope, sessions.authority(login.bearer)).record;
};
const mint = (store: Store, scope: VariantChoiceScope) => {
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const exchanged = ok(sessions.exchange({ projectId: scope.projectId, invitation: issued.invitation }));
  return { sessions, issued, ...exchanged, authority: sessions.authority(exchanged.bearer)! };
};
/** A real paid model decision by the B.2 managed producer — never a hand-written record. */
async function modelReady(f: Awaited<ReturnType<typeof paid>>) {
  const mode = modeOf(f.store, 'bypass'), reply = { action: 'choose', key: 'one', reason: 'Real paid model choice' };
  writeFileSync(f.settings, JSON.stringify({ tokens: 10, reply }));
  // Transport-only service calibration, separate from the real set and from every positive decision/application.
  const cal = reference(f.store.write({ id: 'transport-fixture:owner-variant-cli-decision-calibration',
    kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } }));
  for (const role of [f.environment.value.implementer, f.environment.value.reviewer])
    await researchCall(role, f.environment.value, 'Calibrate decision', { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT,
      kind: 'decision', set: cal, mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: f.calibration.draft.id, questionId: f.calibration.question.id, purpose: 'variant-decision' });
  const input: VariantSessionInput = { projectId: 'p', environment: f.environment, role: f.environment.value.implementer,
    prompt: 'Choose from the exact paid set', variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind: 'decision',
      set: reference(f.set), mode: reference(mode), expectedSelection: reference(f.store.get(variantStateId('p', f.scope.draft.id))!) } };
  return { mode, input };
}

const cliPath = resolve('dist/src/cli.js');
const runCli = (path: string, request: unknown): string => execFileSync(process.execPath,
  [cliPath, 'owner-variant-choice', path], { input: typeof request === 'string' ? request : JSON.stringify(request),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const cliRefusal = (path: string, request: unknown, code?: string) => {
  try { runCli(path, request); }
  catch (error) {
    const stderr = String((error as { stderr?: string }).stderr), line = stderr.split(/\r?\n/)
      .find(row => row.startsWith('{"error"'));
    const body = line ? JSON.parse(line) as { error: string; door?: string } : { error: '' };
    if (code) assert.equal(body.error, code, line);
    assert.equal(body.door, 'owner-variant-choice', line);
    return body;
  }
  assert.fail('the CLI had to refuse this request');
};

test('4O.3: the real CLI commits an initial choose as one exact pair; the exact repeat buys nothing', async t => {
  const f = await paid(t), before = history(f.store), sent = f.wires().length, spent = money(f.store);
  const out = JSON.parse(runCli(f.path, f.scope)) as CliOutcome;
  assert.deepEqual(Object.keys(out).sort(), ['decision', 'repeated', 'state'], 'no credential ever reaches stdout');
  assert.equal(out.repeated, false);
  assert.ok(out.decision.id.startsWith('discovery-variant-owner-decision:'));
  assert.equal(out.state.id, variantStateId('p', f.scope.draft.id));
  const decision = f.store.get<VariantOwnerDecision>(out.decision.id, out.decision.revision)!;
  const state = f.store.get<VariantState>(out.state.id, out.state.revision)!;
  assert.equal(decision.hash, out.decision.hash); assert.equal(state.hash, out.state.hash);
  assert.deepEqual(state.value.decision, reference(decision));
  assert.deepEqual(state.value.result, f.scope.set);
  assert.deepEqual(state.value.previous, f.scope.expectedSelection);
  assert.deepEqual(decision.value.outcome, f.scope.outcome);
  assert.ok(decision.value.authority.session.id.startsWith(VARIANT_CHOICE_SESSION_PREFIX));
  assert.deepEqual(reference(f.store.get('project-mode:p')!), f.scope.mode, 'the global mode is not touched');
  // The pair plus its one-use invitation: the grant and the session that closes on exit.
  assert.equal(history(f.store).length, before.length + 5, 'decision and state land as one pair');
  assert.ok(variantSessions(f.store).every(row => row.value.state === 'closed'), 'the CLI closes its session');
  assert.equal(f.wires().length, sent); assert.deepEqual(money(f.store), spent);
  const cold = new Store(f.path); t.after(() => cold.close());
  const proved = readVariantOwnerDecision(cold, 'p', reference(decision));
  assert.equal(proved.verification, 'proven');
  assert.deepEqual(reference(proved.state), reference(state));
  const again = JSON.parse(runCli(f.path, f.scope)) as CliOutcome;
  assert.equal(again.repeated, true);
  assert.deepEqual(again.decision, out.decision); assert.deepEqual(again.state, out.state);
  assert.equal(f.store.list('discovery-variant-owner-decision').length, 1, 'the repeat writes no new act');
  assert.equal(history(f.store).length, before.length + 8, 'the repeat mints only its one-use invitation and session');
  assert.equal(f.wires().length, sent);
});

test('4O.3: the CLI revise chain and an old exact replay never move the current selection', async t => {
  const f = await paid(t);
  const reject: VariantChoiceScope = { ...f.scope, outcome: { kind: 'reject_all', reason: 'Owner rejects the paid set' } };
  const first = JSON.parse(runCli(f.path, reject)) as CliOutcome;
  assert.ok(f.scope.outcome.kind === 'choose');
  const choose: VariantChoiceScope = { ...f.scope, operation: 'revise', previous: first.decision,
    expectedSelection: first.state, outcome: { kind: 'choose', member: f.scope.outcome.member,
      reason: 'Owner revised to the exact member' } };
  const second = JSON.parse(runCli(f.path, choose)) as CliOutcome;
  const back: VariantChoiceScope = { ...f.scope, operation: 'revise', previous: second.decision,
    expectedSelection: second.state, outcome: { kind: 'reject_all', reason: 'Owner rejects the set again' } };
  const third = JSON.parse(runCli(f.path, back)) as CliOutcome;
  const head = () => f.store.get(variantStateId('p', f.scope.draft.id))!;
  const secondDecision = f.store.get<VariantOwnerDecision>(second.decision.id, second.decision.revision)!;
  const thirdDecision = f.store.get<VariantOwnerDecision>(third.decision.id, third.decision.revision)!;
  assert.deepEqual(secondDecision.value.previous, first.decision);
  assert.deepEqual(thirdDecision.value.previous, second.decision);
  assert.deepEqual(reference(head()), third.state, 'the head is the newest act');
  const cold = new Store(f.path); t.after(() => cold.close());
  for (const saved of [first, second, third])
    assert.deepEqual(reference(readVariantOwnerDecision(cold, 'p', saved.decision).state), saved.state);
  const before = history(f.store);
  const replay = JSON.parse(runCli(f.path, reject)) as CliOutcome;
  assert.equal(replay.repeated, true);
  assert.deepEqual(replay.decision, first.decision); assert.deepEqual(replay.state, first.state);
  assert.deepEqual(reference(head()), third.state, 'the old replay does not reactivate the old selection');
  assert.equal(f.store.list('discovery-variant-owner-decision').length, 3, 'the replay writes no new act');
  assert.equal(history(f.store).length, before.length + 3, 'the replay mints only its one-use invitation and session');
});

test('4O.3: the CLI override acts only on the real paid model bypass decision, then revises', async t => {
  const f = await paid(t);
  // modelReady itself performs the real bypass switch; its mode record is the current head the override pins.
  const b = await modelReady(f), bypass = b.mode;
  await runVariantSession(f.store, b.input);
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!;
  const proved = readVariantModelDecision(f.store, 'p', reference(model));
  assert.ok(proved.state, 'the model decision carries its own admitted state');
  // The one real paid model call above is the only payment; every owner act below must buy nothing.
  const spent = money(f.store), sent = f.wires().length;
  const override: VariantChoiceScope = { ...f.scope, mode: reference(bypass), operation: 'override',
    previous: reference(model), expectedSelection: proved.state! };
  const first = JSON.parse(runCli(f.path, override)) as CliOutcome;
  const decision = f.store.get<VariantOwnerDecision>(first.decision.id, first.decision.revision)!;
  assert.equal(decision.value.operation, 'override');
  assert.deepEqual(decision.value.previous, reference(model));
  assert.deepEqual(reference(f.store.get('project-mode:p')!), reference(bypass), 'the mode stays');
  const revise: VariantChoiceScope = { ...f.scope, mode: reference(bypass), operation: 'revise', previous: first.decision,
    expectedSelection: first.state, outcome: { kind: 'reject_all', reason: 'Owner revised past the model choice' } };
  const second = JSON.parse(runCli(f.path, revise)) as CliOutcome;
  const head = f.store.get(variantStateId('p', f.scope.draft.id))!;
  assert.equal(head.revision, first.state.revision + 1);
  assert.deepEqual(reference(head), second.state);
  const replay = JSON.parse(runCli(f.path, override)) as CliOutcome;
  assert.equal(replay.repeated, true);
  assert.deepEqual(replay.decision, first.decision); assert.deepEqual(replay.state, first.state);
  assert.deepEqual(reference(f.store.get(variantStateId('p', f.scope.draft.id))!), second.state);
  // An owner act is not a model decision; a moved selection is not the admitted one.
  const ownerLike: VariantChoiceScope = { ...f.scope, mode: reference(bypass), operation: 'override',
    previous: first.decision, expectedSelection: first.state };
  cliRefusal(f.path, ownerLike, 'discovery_variant_session_invalid');
  const moved: VariantChoiceScope = { ...override, expectedSelection: second.state };
  cliRefusal(f.path, moved, 'discovery_variant_stale');
  assert.deepEqual(money(f.store), spent, 'no owner act pays again');
  assert.equal(f.wires().length, sent);
});

test('4O.3: wrong, incomplete and credential-carrying CLI scopes refuse before any record', async t => {
  const f = await paid(t), grants = f.store.list('owner-session-grant').length,
    sessions = f.store.list('owner-session').length, decisions = f.store.list('discovery-variant-owner-decision').length;
  cliRefusal(f.path, {}, 'discovery_variant_invalid');
  const missingOutcome = { ...f.scope } as Record<string, unknown>; delete missingOutcome.outcome;
  cliRefusal(f.path, missingOutcome, 'discovery_variant_invalid');
  cliRefusal(f.path, { ...f.scope, bearer: 'a'.repeat(64) }, 'discovery_variant_invalid');
  cliRefusal(f.path, { ...f.scope, invitation: `${'b'.repeat(32)}.${'c'.repeat(64)}` }, 'discovery_variant_invalid');
  cliRefusal(f.path, 'not json', 'discovery_variant_invalid');
  cliRefusal(f.path, { ...f.scope, projectId: 'foreign' }, 'owner_project_missing');
  cliRefusal(f.path, { ...f.scope, outcome: { kind: 'choose', member: { id: 'member:x', revision: 1,
    hash: '0'.repeat(64) }, reason: 'Foreign member' } }, 'discovery_variant_basis_invalid');
  assert.equal(f.store.list('owner-session-grant').length, grants, 'invalid input mints no invitation');
  assert.equal(f.store.list('owner-session').length, sessions);
  assert.equal(f.store.list('discovery-variant-owner-decision').length, decisions);
  // An admissible basis with an inadmissible rule mints once, refuses at the answer door and still closes its session.
  const bypass = modeOf(f.store, 'bypass'), counted = f.store.list('owner-session').length,
    grantsAfterModeOf = f.store.list('owner-session-grant').length;
  cliRefusal(f.path, { ...f.scope, mode: reference(bypass) }, 'discovery_variant_mode_mismatch');
  assert.equal(f.store.list('owner-session-grant').length, grantsAfterModeOf + 1);
  assert.equal(f.store.list('owner-session').length, counted + 1);
  assert.equal(f.store.list('discovery-variant-owner-decision').length, decisions);
  assert.ok(variantSessions(f.store).every(row => row.value.state === 'closed'));
});

test('4O.3: the general command route and credential imitations never reach the variant door', async t => {
  const f = await paid(t), before = history(f.store);
  assert.throws(() => f.engine.execute({ type: 'owner-variant-choice', ...f.scope }),
    (error: unknown) => error instanceof EngineError && error.code === 'command_invalid');
  assert.deepEqual(history(f.store), before, 'the common route writes nothing');
  const m = mint(f.store, f.scope), snapshot = history(f.store);
  for (const authority of [undefined, null, 'owner', { actor: 'owner' }, m.session, m.bearer,
    { exercise: () => ({ ok: true, value: { session: m.session } }) }])
    refuses(() => answerVariantChoice(f.store, f.scope, authority), 'owner_authority_invalid');
  assert.deepEqual(history(f.store), snapshot, 'imitation credentials write nothing');
  assert.equal(f.store.list('discovery-variant-owner-decision').length, 0);
  ok(m.sessions.revoke(m.bearer));
});
