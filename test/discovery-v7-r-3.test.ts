import { fixturePlanAxes, fixturePlanCoverage } from "./discovery-v7-fixture.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, DISCOVERY_CLAIMS_CONTRACT, V7_COMPLETION_RESERVE, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction, V7_PLAN_SUBJECT_CONTRACT, type V7PlanSubject } from '../src/discovery/v7-managed-attempt.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { assessAttempts, assessAttemptsWithRequirements } from '../src/discovery/research-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { discoveryOutcome, discoveryTraversal, type V7Traversal } from '../src/discovery/discovery-outcome.js';
import { issuedForm, outcomeSummary, researchRunId } from '../src/discovery/projection-reader.js';
import { EngineError } from '../src/errors.js';
import { Researcher } from '../src/discovery/research-runner.js';

// R.3 (codex-omg №10880 п.2, №10906): the proved end of the v7 plan traversal on real K → assessment → application.
// The chains are built through the accepted MR/P producers (as P.4 does); the ordinary runner case follows R.2.
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-r3-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

const rand = () => Math.random().toString(16).slice(2);
function validFrame(questions: PlanQuestion[]): Json {
  return { productType: "internal", scale: "30 users across 10 sites",
    industries: ["construction"], domains: ["materials supply", "equipment accounting"],
    axes: fixturePlanAxes(questions),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } };
}
type PlanQuestion = { id: string; axis: string; domain: string; text: string; class: string;
  criterion: string; requiredDepth: string; roles: string[]; searchPlaces: string[] };
function planQuestion(id: string, axis: string, cls = "supporting"): PlanQuestion {
  return { id, axis, domain: "construction", text: `What covers ${id}?`,
    class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
    roles: ["domain expert"], searchPlaces: ["domain documents"] };
}
function questionOf(store: Store, draft: Revision<DiscoveryDraft>, field: string): Revision<Question> {
  const question = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field);
  assert.ok(question, `question for ${field}`);
  return question;
}
/** The real plan acceptance chain (frame and plan through #answer). */
function acceptPlan(f: Fixture, project: string, questions: PlanQuestion[]) {
  const base = createPartialV7Draft(f.discovery, project, "concept");
  const src = f.discovery.evidence.document(project, "basis", `Exact source for ${project}`, "text/plain", 0);
  const frame = questionOf(f.store, base, "frame");
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(questions), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, { edition: 1, frame: frameRef, previous: null, questions, coverage: fixturePlanCoverage(questions) } as unknown as Json, src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
async function setup(t: test.TestContext) {
  const f = fixture(t), project = 'p', wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const settings = join(f.root, 'reply.json');
  writeFileSync(settings, JSON.stringify({ tokens: 10 }));
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const research=settings.reply??{action:'answer',question:r.subject.question?.id??'reader',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:settings.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure(project, { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const old = f.discovery.create(project, 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  const q = f.store.get<Question>(old.value.questions[0]!)!;
  await researchCall(environment.value.implementer, environment.value, 'Calibrate', {}, undefined,
    { store: f.store, draftId: old.id, questionId: q.id, purpose: 'analyst' });
  await researchCall(environment.value.reviewer, environment.value, 'Calibrate', {}, undefined,
    { store: f.store, draftId: old.id, questionId: q.id, purpose: 'assessor' });
  const questions = [planQuestion('q-industry', 'industry', 'blocking'), planQuestion('q-market', 'market')];
  const v = acceptPlan(f, project, questions);
  const subject = (id = 'q-industry'): V7PlanSubject => ({ contract: V7_PLAN_SUBJECT_CONTRACT, planAnswer: v.planAnswer, planQuestionId: id });
  const prompt = 'Research the selected plan question; return an answer with a V7AttemptEnd value and empty citations.';
  let runId: string | undefined;
  const prepare = (selected = subject(), context: Record<string, any> = { history: [], readings: [] }) => {
    const draft = f.store.get<DiscoveryDraft>(v.draft.id)!, question = f.store.get<Question>(v.plan.id)!;
    const run = runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({ id: `research-run:${rand()}`, kind: 'research-run', expected: 0,
      value: { projectId: project, draftId: draft.id, environment: reference(environment), turns: 0, limit: 100, requestChars: 0,
        owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'running', inputs: draft.value.inputs } });
    runId = run.id; const number = run.value.turns + 1;
    const input = { projectId: project, kind: 'analyst' as const, key: hashJson([run.id, number, 'analyst']), owner: reference(run),
      draft: reference(draft), question: reference(question), role: environment.value.implementer, dispatch: environment.value, profile: null,
      cursor: { run: run.id, turn: number, instruction: prompt, context, subject: selected }, basis: draft.value.inputs,
      guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(environment)]) };
    const intent = prepareResearchConsumerIntent(f.store, input);
    const invoke = () => researchCall(environment.value.implementer, environment.value, prompt, context, undefined,
      { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent),
        requestContract: REQUEST_MANIFEST_CONTRACT });
    return { run, number, intent, invoke, question, draft, selected, context };
  };
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean);
  return { ...f, v, project, questions, subject, prepare, wires, environment, settings };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const noEnd = () => ({ type: 'impossible', code: 'source_unavailable', evidence: [], text: 'No source' });
function hypothesis(f: Setup, text: string, question = 'q-industry') {
  return { type: 'submitted', contract: DISCOVERY_CLAIMS_CONTRACT, value: { claims: [{ id: 'h', kind: 'hypothesis', text,
    axis: 'industry', planQuestions: [{ planAnswer: f.v.planAnswer, planQuestionId: question }], scope: { variants: 'common' },
    basis: { howToVerify: 'Measure it' } }] } };
}
/** One paid analyst call of the plan question, its turn, the attempt K and its binding — every record by its producer. */
async function produce(f: Setup, end: unknown = noEnd(), question = 'q-industry', tokens = 10) {
  writeFileSync(f.settings, JSON.stringify({ tokens, reply: { action: 'answer', question, value: end, citations: [] } }));
  const m = f.prepare(f.subject(question)), response = await m.invoke();
  const execution = readResearchConsumerExecution(f.store, 'p', reference(m.intent));
  assert.equal(execution.kind, 'response');
  const projected = projectPaidTurnAdmission(m.run.value, { runId: m.run.id, intent: reference(m.intent), response,
    question: reference(m.question), owner: m.run.value.owner, limit: 100, context: m.context, subject: m.selected });
  const turnId = managedTurnId(m.run.id, m.number);
  const application = prepareResearchConsumerApplication(f.store, reference(m.intent), reference(execution.call), [
    { id: m.run.id, kind: m.run.kind, expected: m.run.revision, value: projected.run },
    { id: turnId, kind: 'research-turn', expected: 0, value: projected.turn }],
  [reference(m.run), reference(f.environment), { id: turnId, absent: true }]);
  f.store.writeMany(application.writes, application.guards);
  const call = f.store.get<ResearchConsumerIntent>(m.intent.id)!.value.call!;
  const recorded = recordV7Attempt(f.store, { project: 'p', planAnswer: m.selected.planAnswer, planQuestionId: question,
    call, end: attemptEndOfAction(response, m.selected) });
  const done = completeResearchAttemptTurn(f.store, 'p', reference(f.store.get(turnId)!), reference(recorded.attempt));
  return { attempt: reference(recorded.attempt), binding: reference(done.binding) };
}
type Entry = Awaited<ReturnType<typeof produce>>;
/** The paid assessment of one exact packet (MR), with no progress unless a claim is accepted or a transition named. */
async function assess(f: Setup, entries: Entry[], options: { question?: string; accept?: boolean; requirements?: boolean;
  transition?: (claims: ClaimAddress[], entries: Entry[]) => unknown; tokens?: number } = {}) {
  const question = options.question ?? 'q-industry';
  const packet = projectAttemptPacket(f.store, { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: question, entries });
  const baseline = v7ProgressBaseline(f.store, packet);
  const claims: ClaimAddress[] = entries.flatMap(e => {
    const row = f.store.get<any>(e.attempt.id, e.attempt.revision)!;
    return row.value.end.type === 'submitted' ? row.value.end.value.claims.map((claim: any, index: number) =>
      ({ project: 'p', container: e.attempt, containerKind: row.kind, pointer: `/claims/${index}`, claimId: claim.id })) : [];
  });
  const accepted = options.accept ? claims : [];
  const transition = options.transition?.(accepted, entries) ?? null;
  const constrained = (e: Entry) => (transition as any)?.bases?.some((b: any) => b.constraint?.id === e.attempt.id);
  const novelty = { attempts: entries.map(e => ({ attempt: e.attempt, reason: 'Assessed exact result' })),
    accepted: accepted.map(claim => ({ claim, reason: 'Supported hypothesis' })),
    rejected: claims.filter(c => !accepted.includes(c)).map(claim => ({ claim, reason: 'Unproved' })),
    newContent: accepted.map(claim => ({ claim, reason: 'New basis' })), duplicates: [],
    noProgress: entries.filter(e => !accepted.some(c => c.container.id === e.attempt.id) && !constrained(e))
      .map(e => ({ attempt: e.attempt, reason: 'No new basis' })),
    transition };
  const reply = { verdict: 'supported', reasons: ['Assess exact packet'], return: null, novelty,
    methodology: { contract: 'assessment-methodology/v1', policy: options.requirements ? 'assessment-methodology-policy/v2' : 'assessment-methodology-policy/v1', facts: [] } };
  writeFileSync(f.settings, JSON.stringify({ tokens: options.tokens ?? 10, reply }));
  const paid = await (options.requirements ? assessAttemptsWithRequirements : assessAttempts)(f.store, packet, baseline, f.environment, f.root);
  return { paid, packet, claims };
}
/** Closed: an accepted hypothesis grounds the plan's own criterion (explicit empty methodology requirements, v3). */
async function close(f: Setup, question = 'q-industry', tokens = 10) {
  const entry = await produce(f, hypothesis(f, `A declared basis of ${question}`, question), question);
  const plan = f.questions.find(row => row.id === question)!;
  const a = await assess(f, [entry], { question, accept: true, requirements: true, transition: claims => ({ outcome: 'closed',
    bases: claims.map(claim => ({ claim })), reason: 'Non-factual criterion met',
    sufficiency: { criterion: plan.criterion, requiredDepth: plan.requiredDepth, reason: 'The question concerns the declared hypothesis',
      methodologyRequirements: [] } }), tokens });
  applyDiscoveryAssessment(f.store, 'p', reference(a.paid));
  return entry;
}
/** Unknown: an impossible attempt with its evidence is the proven constraint of a supporting question. */
async function unknown(f: Setup, question = 'q-market', tokens = 10) {
  const evidence = f.discovery.evidence.document('p', `absent-${rand()}`, 'The registry is not published', 'text/plain', 0);
  const entry = await produce(f, { type: 'impossible', code: 'source_unavailable', evidence: [reference(evidence)], text: 'No registry' }, question);
  const a = await assess(f, [entry], { question, transition: (_claims, entries) => ({ outcome: 'unknown',
    bases: entries.map(e => ({ constraint: e.attempt })), reason: 'The required registry is not published' }), tokens });
  applyDiscoveryAssessment(f.store, 'p', reference(a.paid));
  return entry;
}
/** Stalled: three distinct assessed attempts of one packet add no accepted basis (N=3). */
async function stall(f: Setup, question = 'q-industry', tokens = 10) {
  const entries = [await produce(f, noEnd(), question), await produce(f, noEnd(), question), await produce(f, noEnd(), question)];
  const a = await assess(f, entries, { question, tokens });
  applyDiscoveryAssessment(f.store, 'p', reference(a.paid));
  return entries;
}
const draftOf = (f: Setup) => f.store.get<DiscoveryDraft>(f.v.draft.id)!;
const traversal = (f: Setup, store = f.store) => discoveryTraversal(store, store.get<DiscoveryDraft>(f.v.draft.id)!)!;
const subjectOf = (f: Setup, id: string) => ({ project: 'p', planAnswer: f.v.planAnswer, planQuestionId: id });
const snapshot = (store: Store) => store.list().map(row => [row.id, row.revision, row.hash]);
/** The read changes nothing, sends nothing, and a cold Store reads the same end; Discovery stays researching. */
function readOnly(f: Setup, expected: V7Traversal) {
  const before = snapshot(f.store), sent = f.wires().length, cold = f.open();
  assert.deepEqual(traversal(f, cold), expected);
  assert.equal(discoveryOutcome(cold, cold.get<DiscoveryDraft>(f.v.draft.id)!).state, 'researching');
  assert.equal(cold.get('stage:p:discovery'), null, 'no traversal end accepts Discovery');
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.wires().length, sent);
}

test('R.3: before any attempt the front is open with every subject unstarted; a bare completed run proves nothing', async t => {
  const f = await setup(t);
  const first = traversal(f);
  assert.equal(first.end, 'open');
  assert.equal(first.subject, null);
  assert.deepEqual(first.subjects.map(row => [row.subject.planQuestionId, row.outcome, row.class]),
    [['q-industry', 'unstarted', 'blocking'], ['q-market', 'unstarted', 'supporting']]);
  assert.equal(first.budget, null, 'the stage segment is not created for reading');
  // Negative mutation: the draft's own run record claims completion. The run is never a ground of an end.
  f.store.write<ResearchRun>({ id: researchRunId('p', f.v.draft.id), kind: 'research-run', expected: 0,
    value: { projectId: 'p', draftId: f.v.draft.id, environment: reference(f.environment), turns: 9, limit: 9, requestChars: 0,
      owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null, status: 'completed',
      inputs: draftOf(f).value.inputs } });
  const forged = traversal(f);
  assert.equal(forged.end, 'open');
  assert.deepEqual(forged.subjects, first.subjects);
  assert.equal(forged.pause, null);
  readOnly(f, forged);
});

test('R.3: completed attempts wait for their assessment — unpaid, then paid but unapplied — on their exact subject', async t => {
  const f = await setup(t), entry = await produce(f);
  const unpaid = traversal(f);
  assert.equal(unpaid.end, 'assessment_unpaid');
  assert.deepEqual(unpaid.subject, subjectOf(f, 'q-industry'));
  assert.match(unpaid.reason!, new RegExp(`q-industry of plan answer ${f.v.planAnswer.id}@${f.v.planAnswer.revision}`));
  assert.deepEqual(unpaid.subjects[0]!.pending, [entry.attempt]);
  assert.deepEqual(unpaid.subjects[0]!.assessments, []);
  assert.equal(unpaid.subjects[0]!.outcome, 'open');
  readOnly(f, unpaid);
  const a = await assess(f, [entry]);
  const unapplied = traversal(f);
  assert.equal(unapplied.end, 'assessment_unapplied');
  assert.deepEqual(unapplied.subject, subjectOf(f, 'q-industry'));
  assert.deepEqual(unapplied.subjects[0]!.assessments, [reference(a.paid)]);
  assert.deepEqual(unapplied.subjects[0]!.pending, [entry.attempt]);
  readOnly(f, unapplied);
  applyDiscoveryAssessment(f.store, 'p', reference(a.paid));
  const applied = traversal(f);
  assert.equal(applied.end, 'open');
  assert.deepEqual(applied.subjects.map(row => [row.outcome, row.pending.length]), [['open', 0], ['unstarted', 0]]);
  assert.ok(applied.subjects[0]!.state);
  const firstState = f.store.get<any>(applied.subjects[0]!.state!.id, applied.subjects[0]!.state!.revision)!;
  assert.deepEqual(applied.subjects[0]!.applications, [firstState.value.application]);
  assert.deepEqual(applied.subjects[1]!.applications, []);
  readOnly(f, applied);
  // A second application of the same subject extends the chain in order: first to last, without repeats.
  const second = await produce(f), b = await assess(f, [second]);
  applyDiscoveryAssessment(f.store, 'p', reference(b.paid));
  const chained = traversal(f), lastState = f.store.get<any>(chained.subjects[0]!.state!.id, chained.subjects[0]!.state!.revision)!;
  assert.deepEqual(chained.subjects[0]!.applications, [firstState.value.application, lastState.value.application]);
  assert.notDeepEqual(firstState.value.application, lastState.value.application);
  readOnly(f, chained);
});

test('R.3: an assessment of another subject or packet is not the unapplied assessment of this one', async t => {
  const f = await setup(t), industry = await produce(f), market = await produce(f, noEnd(), 'q-market');
  const foreign = await assess(f, [market], { question: 'q-market' });
  const read = traversal(f);
  assert.equal(read.end, 'assessment_unpaid', 'the paid assessment of q-market does not cover q-industry');
  assert.deepEqual(read.subject, subjectOf(f, 'q-industry'));
  assert.deepEqual(read.subjects.map(row => row.assessments), [[], [reference(foreign.paid)]]);
  assert.deepEqual(read.subjects.map(row => row.pending), [[industry.attempt], [market.attempt]]);
  readOnly(f, read);
});

test('R.3: one stalled subject does not stop the front; every unfinished subject stalled is the stalled end of the first', async t => {
  const f = await setup(t);
  await stall(f, 'q-industry');
  const one = traversal(f);
  assert.equal(one.end, 'open');
  assert.deepEqual(one.subjects.map(row => row.outcome), ['stalled', 'unstarted']);
  readOnly(f, one);
  await stall(f, 'q-market');
  const both = traversal(f);
  assert.equal(both.end, 'stalled');
  assert.deepEqual(both.subject, subjectOf(f, 'q-industry'));
  assert.match(both.reason!, /q-industry .* is stalled: Three distinct assessed attempts produced no new accepted basis/);
  readOnly(f, both);
});

test('R.3: closed and unknown subjects complete the front, which still does not accept Discovery', async t => {
  const f = await setup(t);
  await close(f, 'q-industry');
  const half = traversal(f);
  assert.equal(half.end, 'open');
  assert.deepEqual(half.subjects.map(row => row.outcome), ['closed', 'unstarted']);
  await unknown(f, 'q-market');
  const done = traversal(f);
  assert.equal(done.end, 'completed');
  assert.equal(done.subject, null);
  assert.deepEqual(done.subjects.map(row => row.outcome), ['closed', 'unknown']);
  assert.deepEqual(discoveryOutcome(f.store, draftOf(f)), { state: 'researching', verdict: null, report: null, conditions: [],
    ownerChoices: [], reason: null, guards: discoveryOutcome(f.store, draftOf(f)).guards, findings: [] });
  readOnly(f, done);
  // projection-reader: the summary keeps its outcome and reads the same traversal lazily.
  const summary = outcomeSummary(f.store, draftOf(f), issuedForm(f.store, draftOf(f)));
  assert.equal(summary.outcome.state, 'researching');
  assert.deepEqual(summary.traversal, done);
});

/** The input tokens of the next paid call that leave the stage exactly at its reserve, or past its limit. */
function ending(f: Setup, kind: 'overrun' | 'exhausted'): number {
  const budget = traversal(f).budget!;
  assert.equal(budget.reserved, 0, 'every earlier call is settled');
  return kind === 'overrun' ? V7_STAGE_TOKEN_CEILING : V7_STAGE_TOKEN_CEILING - V7_COMPLETION_RESERVE - budget.measured - 1;
}
const budgetRefused = (error: unknown) => error instanceof EngineError
  && ['discovery_budget_overrun', 'discovery_budget_reserve'].includes(error.code);

test('R.3: a measured overrun or no remaining research tokens is the limit of an open front, and it refuses the next send', async t => {
  for (const kind of ['overrun', 'exhausted'] as const) await t.test(kind, async child => {
    const f = await setup(child), entry = await produce(f);
    assert.equal(traversal(f).budget!.exhausted, false);
    // The paid assessment itself spends the budget; applying it is free, so no assessment waits and the front is open.
    applyDiscoveryAssessment(f.store, 'p', reference((await assess(f, [entry], { tokens: ending(f, kind) })).paid));
    const limit = traversal(f);
    assert.equal(limit.end, 'limit');
    assert.equal(limit.subject, null);
    assert.deepEqual(limit.subjects.map(row => row.outcome), ['open', 'unstarted']);
    assert.equal(limit.budget!.exhausted, true);
    assert.equal(limit.budget!.overrun, kind === 'overrun');
    assert.ok(limit.budget!.remaining <= 0);
    assert.ok(limit.reason!.includes(limit.budget!.segment.id), 'the limit names its exact stage budget');
    readOnly(f, limit);
    // The limit is real: the next research send is refused by the stage budget before it is paid.
    const sent = f.wires().length;
    await assert.rejects(() => produce(f, noEnd(), 'q-market'), budgetRefused);
    assert.equal(f.wires().length, sent);
  });
});

test('R.3: an exhausted budget accompanies a pending assessment, a stalled front and a completed front without masking them', async t => {
  await t.test('pending', async child => {
    const f = await setup(child);
    await produce(f);
    await produce(f, noEnd(), 'q-market', ending(f, 'overrun'));
    const read = traversal(f);
    assert.equal(read.end, 'assessment_unpaid');
    assert.deepEqual(read.subject, subjectOf(f, 'q-industry'));
    assert.equal(read.budget!.exhausted, true);
    readOnly(f, read);
  });
  await t.test('stalled', async child => {
    const f = await setup(child);
    await stall(f, 'q-industry');
    await stall(f, 'q-market', ending(f, 'overrun'));
    const read = traversal(f);
    assert.equal(read.end, 'stalled');
    assert.deepEqual(read.subject, subjectOf(f, 'q-industry'));
    assert.equal(read.budget!.exhausted, true);
    readOnly(f, read);
  });
  await t.test('completed', async child => {
    const f = await setup(child);
    await close(f, 'q-industry');
    await unknown(f, 'q-market', ending(f, 'exhausted'));
    const read = traversal(f);
    assert.equal(read.end, 'completed');
    assert.equal(read.budget!.exhausted, true);
    readOnly(f, read);
  });
});

test('R.3: a saved budget pause of the run is a diagnostic only: a forged estimate makes no limit', async t => {
  const f = await setup(t), entry = await produce(f);
  applyDiscoveryAssessment(f.store, 'p', reference((await assess(f, [entry])).paid));
  const before = traversal(f);
  // Negative mutation: the draft's run claims a reserve refusal with an estimate no saved record supports.
  const error = canonical({ code: 'discovery_budget_reserve', message: 'Reserve refused', details: { segment: before.budget!.segment,
    class: 'research', remaining: 5, estimate: 1e12 } });
  const run = f.store.write<ResearchRun>({ id: researchRunId('p', f.v.draft.id), kind: 'research-run', expected: 0,
    value: { projectId: 'p', draftId: f.v.draft.id, environment: reference(f.environment), turns: 1, limit: 9, requestChars: 0,
      owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error, status: 'paused',
      pauseCode: 'discovery_budget_reserve', inputs: draftOf(f).value.inputs } });
  const read = traversal(f);
  assert.equal(read.end, 'open');
  assert.deepEqual(read.budget, before.budget);
  assert.deepEqual(read.pause, { run: reference(run), code: 'discovery_budget_reserve', error });
  assert.deepEqual({ ...read, pause: null }, { ...before, pause: null });
  readOnly(f, read);
});

test('R.3: a damaged ledger of the saved segment is a typed refusal, never zero usage', async t => {
  const f = await setup(t);
  await produce(f);
  const ledger = f.store.get(`research-budget-ledger:${hashJson(traversal(f).budget!.segment.id)}`)!;
  // Negative mutation: an assigned call vanishes from the ledger's accounting.
  f.store.write({ id: ledger.id, kind: ledger.kind, expected: ledger.revision,
    value: { ...(ledger.value as Record<string, Json>), assignments: [{ call: 'model-call:p:missing', groups: ['discovery-v7'],
      estimate: { kind: 'estimated', tokens: 1, basis: [], explanation: 'forged' } }] } as unknown as Json });
  assert.throws(() => traversal(f), (error: unknown) => error instanceof EngineError && error.code === 'budget_call_missing');
});

test('R.3: a forged attempt of the plan is a typed refusal of the common attempt reader, never a pending or an applied K', async t => {
  const f = await setup(t), entry = await produce(f);
  const saved = f.store.get<Record<string, Json>>(entry.attempt.id, entry.attempt.revision)!;
  // Negative mutation: a renamed copy of a real attempt under an id that is not the deterministic id of its key.
  f.store.write({ id: `${saved.id}-copy`, kind: saved.kind, expected: 0, value: saved.value });
  assert.throws(() => traversal(f), (error: unknown) => error instanceof EngineError && error.code === 'attempt_invalid');
});

// ---- R.3 end to end on the ordinary runner (R.2 merged, om/module 1b4be1fb): the setup of the accepted R.1 test ----
async function runnerSetup(t: test.TestContext, questions = [planQuestion('support', 'market'), planQuestion('block', 'industry', 'blocking')]) {
  const f = fixture(t); f.engine.execute({ type: 'create-project', project: 'p', title: 'P' });
  const wire = join(f.root, 'wire.ndjson'), settings = join(f.root, 'reply.json'), adapter = join(f.root, 'adapter.mjs');
  const configure = (replies: unknown[] = [], tokens: number | null = 10) => writeFileSync(settings, JSON.stringify({ replies, tokens }));
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
let previous=[];try{previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},raw+'\\n');
const ordinal=previous.map(line=>JSON.parse(line)).filter(row=>!row.subject.assessmentSubject).length;
let research=s.replies[ordinal]??{action:'answer',question:r.subject.question?.id??'probe',value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=r.subject.question.id;
if(s.terminalConstraint&&research.action==='answer')research.value.evidence=[s.terminalConstraint];
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 research={verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected:[],newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
 if(s.terminalConstraint){research.verdict='supported';research.return=null;research.novelty.noProgress=[];research.novelty.transition={outcome:'unknown',bases:[{constraint:packet.entries[0].attempt}],reason:'Source unavailable',consequence:'The named basis remains unknown',nextAction:'Obtain another source'};}
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,...(s.tokens===null?{}:{usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}})}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command }, reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  const ended = { action: 'answer', question: '$selected', value: { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'No accessible source' }, citations: [] };
  const audit = (purpose: string) => ({ store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  await researchCall(environment.value.implementer, environment.value, 'Calibrate', {}, undefined, audit('analyst') as any);
  configure([ended, { necessary: true, reason: 'Calibration review' }]);
  await researchCall(environment.value.reviewer, environment.value, 'Calibrate reviewer', {}, undefined, audit('escalation-assessor') as any);
  await researchCall(environment.value.reviewer, environment.value, 'Calibrate assessor', {}, undefined, audit('assessor') as any);
  await researchCall(environment.value.implementer, environment.value, 'Calibrate planner', { dispatchMode: 'planning' }, undefined, audit('reading-planner') as any);
  configure(); writeFileSync(wire, '');
  const v = acceptPlan(f, 'p', questions);
  // The real paid unknown of every subject: an unavailable source with its saved evidence (R.1 finishFrontier).
  const finishFrontier = () => writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')),
    terminalConstraint: reference(f.discovery.evidence.document('p', 'terminal-source', 'The requested source is unavailable', 'text/plain', 0)) }));
  const run = (limit = 8, store = f.store, policy = true) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, policy ? { producerPolicy: { discovery: 7 } } : {});
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean);
  return { ...f, v, questions, run, wires, finishFrontier };
}
/** The R.1 cut: the paid assessment is published, and the run stops before its application. */
function beforeApply(f: Awaited<ReturnType<typeof runnerSetup>>) {
  const write = f.store.writeMany.bind(f.store); let hit = false;
  f.store.writeMany = ((writes, guards = []) => {
    if (!hit && writes.some(w => w.kind === 'v7-progress-application')) { hit = true; throw new Error('R3 cut before-apply'); }
    return write(writes, guards);
  }) as typeof f.store.writeMany;
  return () => { f.store.writeMany = write; assert.ok(hit, 'the real producer reached its application'); };
}
const runnerTraversal = (f: { store: Store; v: { draft: Revision<DiscoveryDraft> } }, store = f.store) =>
  discoveryTraversal(store, store.get<DiscoveryDraft>(f.v.draft.id)!)!;

test('R.3 end to end: the ordinary runner pauses after the broad pass on proved unknowns without accepting Discovery', async t => {
  const f = await runnerSetup(t); f.finishFrontier();
  const run = await f.run();
  assert.equal(run.value.status,'paused');assert.equal(run.value.pauseCode,'project_mode_unset',JSON.stringify(run.value));
  const read = runnerTraversal(f);
  assert.equal(read.end, 'completed');
  assert.deepEqual(read.subjects.map(row => [row.subject.planQuestionId, row.outcome, row.applications.length, row.pending.length]),
    [['support', 'unknown', 1, 0], ['block', 'unknown', 1, 0]]);
  const before = f.store.list().map(row => [row.id, row.revision, row.hash]), sent = f.wires().length, cold = f.open();
  assert.deepEqual(runnerTraversal(f, cold), read);
  assert.equal(discoveryOutcome(cold, cold.get<DiscoveryDraft>(f.v.draft.id)!).state, 'researching');
  assert.equal(cold.get('stage:p:discovery'), null);
  assert.deepEqual(f.store.list().map(row => [row.id, row.revision, row.hash]), before);
  assert.equal(f.wires().length, sent);
});

test('R.3 end to end: a run marked completed with its paid assessment unapplied is the unapplied end of its exact subject', async t => {
  const f = await runnerSetup(t, [planQuestion('block', 'industry', 'blocking')]); f.finishFrontier();
  const restore = beforeApply(f), stopped = await f.run(); restore();
  assert.equal(stopped.value.status, 'paused');
  // Negative mutation, as the accepted R.1 recovery does: the run claims completion before the application.
  const saved = f.store.get<ResearchRun>(stopped.id)!;
  f.store.write({ id: saved.id, kind: saved.kind, expected: saved.revision, value: { ...saved.value, status: 'completed' } });
  const pending = runnerTraversal(f);
  assert.equal(pending.end, 'assessment_unapplied');
  assert.deepEqual(pending.subject, { project: 'p', planAnswer: f.v.planAnswer, planQuestionId: 'block' });
  assert.equal(pending.subjects[0]!.assessments.length, 1);
  assert.deepEqual(pending.subjects[0]!.applications, []);
  // The free recovery of the runner applies the paid assessment without another send; the front is then completed.
  const sent = f.wires().length, done = await f.run(1, f.open(), false);
  assert.equal(done.value.status,'paused');assert.equal(done.value.pauseCode,'research_restore_complete',JSON.stringify(done.value));
  assert.equal(f.wires().length, sent);
  const read = runnerTraversal(f, f.open());
  assert.equal(read.end, 'completed');
  assert.deepEqual(read.subjects[0]!.applications.length, 1);
});
