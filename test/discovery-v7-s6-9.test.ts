import { readV7ProgressStateAt } from '../src/discovery/v7-progress.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { createPartialV7Draft, V7_AXES, V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import type { Json } from '../src/canonical.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { stageSummary, renderStageSummary } from '../src/product/stage-summary.js';

// S6.9 (codex-omg №9689): the stage summary reproduces the saved meaning of a v7 run —
// the logical question (planQuestionId + exact plan edition) of its owner pause or paid
// model pause, an explicit unbound stop, and an addressed refusal for a damaged basis —
// over real S6.1–S6.3 producers. A cold summary calls no adapter and writes nothing.

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "omg-s69-"));
  const path = join(root, "state.sqlite"), stores: Store[] = [];
  const open = () => { const db = new Store(path); stores.push(db); return db; };
  const store = open(), engine = new ProductEngine(store), discovery = new Discovery(store);
  t.after(() => { for (const db of stores) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, engine, discovery, open };
}
type Fixture = ReturnType<typeof fixture>;

const allAxes = (depth: string) => Object.fromEntries(V7_AXES.map(axis => [axis, { depth }]));
function validFrame(): Json {
  return { productType: "internal", scale: "30 users across 10 sites",
    industries: ["construction"], domains: ["materials supply", "equipment accounting"],
    axes: allAxes("deep"),
    budget: { ceiling: V7_STAGE_TOKEN_CEILING, axisHints: { industry: 4_000_000 }, completionReserve: 2_000_000 } };
}
type PlanQuestion = { id: string; axis: string; domain: string; text: string; class: string;
  criterion: string; requiredDepth: string; roles: string[]; searchPlaces: string[] };
function planQuestion(id: string, axis: string, cls = "supporting"): PlanQuestion {
  return { id, axis, domain: "construction", text: `What covers ${id}?`,
    class: cls, criterion: `Named basis answering ${id}`, requiredDepth: "deep",
    roles: ["domain expert"], searchPlaces: ["domain documents"] };
}
function validPlan(frameRef: Ref, questions: PlanQuestion[], edition = 1, previous: Ref | null = null): Json {
  return { edition, frame: frameRef, previous, questions } as unknown as Json;
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
  answerDiscoveryFixture(f.engine, project, base, frame, validFrame(), src);
  const frameRef = f.store.get<Question>(frame.id)!.value.answer!;
  const planQ = questionOf(f.store, base, "plan");
  answerDiscoveryFixture(f.engine, project, base, planQ, validPlan(frameRef, questions), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(base.id)!, plan, planAnswer: plan.value.answer!, frameRef };
}
/** The next lawful plan edition: reopen and accept again. */
function acceptNextPlanEdition(f: Fixture, project: string, draft: Revision<DiscoveryDraft>, frameRef: Ref,
  previous: Ref, questions: PlanQuestion[]) {
  const planQ = questionOf(f.store, f.store.get<DiscoveryDraft>(draft.id)!, "plan");
  f.discovery.reopen(planQ.id, planQ.revision);
  const reopened = f.store.get<Question>(planQ.id)!;
  const src = f.discovery.evidence.document(project, "basis-next", "Source of the next edition", "text/plain", 0);
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!, reopened,
    validPlan(frameRef, questions, 2, previous), src);
  return f.store.get<Question>(planQ.id)!.value.answer!;
}

async function setup(t: test.TestContext, questions = [planQuestion('support', 'market'), planQuestion('block', 'industry', 'blocking')]) {
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
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet,attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 const rejected=(r.subject.value?.attempts??[]).flatMap(entry=>entry.end.type==='submitted'?entry.end.value.claims.map((claim,index)=>({claim:{project:packet.project,container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id},reason:'Insufficient corroboration'})):[]);
 research=s.assessmentReply??{verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected,newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
} 
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,...(s.tokens===null?{}:{usage:{inputTokens:s.tokens,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}})}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command }, reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command },
    fullCheck: command, timeoutMs: 5000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  configure([], 10);
  await researchCall(environment.value.implementer, environment.value, 'Calibrate', {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'analyst' });
  configure([ended(), { necessary: true, reason: 'Calibration review' }], 10);
  await researchCall(environment.value.reviewer, environment.value, 'Calibrate reviewer', {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'escalation-assessor' });
  await researchCall(environment.value.reviewer, environment.value, 'Calibrate assessor', {}, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: 'assessor' });
  configure(); writeFileSync(wire, '');
  const v = acceptPlan(f, 'p', questions);
  const run = (limit = 8, store = f.store, policy = true) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, policy ? { producerPolicy: { discovery: 7 } } : {});
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).length;
  const history = () => f.store.list().map(row => [row.id, row.revision, row.hash]);
  /** A cold summary: a fresh Store, no adapter call, no model-call, ledger or any other write. */
  const cold = () => {
    const before = history(), calls = wires(), db = f.open();
    const summary = stageSummary(db, 'p', 'discovery', v.draft.id), text = renderStageSummary(summary);
    assert.deepEqual(history(), before, 'a cold summary writes nothing'); assert.equal(wires(), calls, 'a cold summary calls no adapter');
    return { summary, candidate: summary.candidate!, text };
  };
  return { ...f, v, run, configure, cold, wires };
}

const ended = (type = 'impossible') => ({ action: 'answer', question: '$selected', value: { type, code: 'source_unavailable', evidence: [], text: 'No accessible source' }, citations: [] });
const pause = (reason: string) => ({ action: 'pause', reason });
const turns = (store: Store) => store.list<any>('research-turn').sort((a, b) => a.value.number - b.value.number);

test('S6.9: a paid model pause names its logical question — two logical questions of one physical Question stay distinct, and the code, reason and door stay verbatim', async t => {
  const f = await setup(t); f.configure([ended(), pause('Need the regional retention act')]);
  const run = await f.run();
  assert.equal(run.value.status, 'paused', JSON.stringify(run.value)); assert.equal(run.value.pauseCode, 'research_model_paused');
  const [first, last] = turns(f.store);
  assert.deepEqual([first!.value.subject.planQuestionId, last!.value.subject.planQuestionId], ['block', 'support']);
  assert.deepEqual(first!.value.question, last!.value.question, 'both logical questions live on one physical Question');
  const { candidate, text } = f.cold();
  assert.equal(candidate.runFailure, null, JSON.stringify(candidate.runFailure));
  assert.deepEqual(candidate.run!.subject, { contract: 'v7-plan-subject/v1', planAnswer: f.v.planAnswer, planQuestionId: 'support' });
  assert.equal(candidate.run!.subjectBinding, 'model-pause'); assert.equal(candidate.run!.subjectText, 'What covers support?');
  assert.deepEqual(candidate.run!.question, last!.value.question, 'the physical Question stays the ground');
  assert.deepEqual([candidate.run!.pauseCode, candidate.run!.error, candidate.run!.door, candidate.run!.missing],
    ['research_model_paused', 'Need the regional retention act', 'research-stage', ['Need the regional retention act']]);
  assert.match(text, new RegExp(`Вопрос: ${f.v.plan.id}@${last!.value.question.revision}`));
  assert.ok(text.includes(`Логический вопрос: support; план ${f.v.planAnswer.id}@${f.v.planAnswer.revision} (оплаченная пауза модели): What covers support?`), text);
  assert.ok(!text.includes('Логический вопрос: block'), 'the earlier logical question of the same physical Question is not the pause');
  assert.ok(text.includes('Код паузы: research_model_paused') && text.includes('Причина остановки: Need the regional retention act'));
});

test('S6.9: an owner pause keeps its logical question and exact plan edition in a cold summary after a new accepted edition', async t => {
  const f = await setup(t, [planQuestion('block', 'industry', 'blocking')]);
  const source = f.discovery.evidence.document('p', 'owner-research', 'The owner chooses a jurisdiction.', 'text/plain', 0), ref = reference(source);
  f.configure([{ action: 'read_source', source: ref, start: 0, end: source.value.content.length },
    { action: 'need_owner', question: '$selected', reason: 'Choose a jurisdiction', searched: [ref] },
    { necessary: true, reason: 'Jurisdiction must be chosen by the owner' }]);
  const run = await f.run(); assert.equal(run.value.status, 'needs_owner', JSON.stringify(run.value));
  const before = f.cold();
  assert.equal(before.candidate.run!.subjectBinding, 'owner'); assert.equal(before.candidate.run!.subjectText, 'What covers block?');
  const next = acceptNextPlanEdition(f, 'p', f.v.draft, f.v.frameRef, f.v.planAnswer, [planQuestion('next', 'market')]);
  assert.notDeepEqual(next, f.v.planAnswer);
  const { candidate, text } = f.cold();
  assert.equal(candidate.runFailure, null, JSON.stringify(candidate.runFailure));
  assert.deepEqual(candidate.run!.subject, { contract: 'v7-plan-subject/v1', planAnswer: f.v.planAnswer, planQuestionId: 'block' },
    'a new edition does not readdress the old pause');
  assert.equal(candidate.run!.subjectText, 'What covers block?', 'the text comes from the exact old edition');
  assert.deepEqual(candidate.run!.missing, ['Jurisdiction must be chosen by the owner']);
  assert.ok(text.includes(`Логический вопрос: block; план ${f.v.planAnswer.id}@${f.v.planAnswer.revision} (пауза до решения владельца): What covers block?`), text);
  assert.ok(!text.includes('Логический вопрос: next'), 'the next question of today\'s plan is not the pause');
});

for (const [name, limit, replies, tokens, code] of [
  ['turn limit', 1, [ended()], 10, 'research_turns_exhausted'],
  ['budget', 8, [], V7_STAGE_TOKEN_CEILING, 'discovery_budget_overrun']] as const)
  test(`S6.9: a ${name} stop before the next subject is fixed shows an unbound stop — never the last answered or the next planned question`, async t => {
    const f = await setup(t); f.configure([...replies], tokens);
    const run = await f.run(limit);
    assert.equal(run.value.status, 'paused'); assert.equal(run.value.pauseCode, code, JSON.stringify(run.value));
    assert.equal(turns(f.store).at(-1)!.value.subject.planQuestionId, 'block', 'the last paid turn answered block');
    const { candidate, text } = f.cold();
    assert.equal(candidate.runFailure, null, JSON.stringify(candidate.runFailure));
    assert.equal(candidate.run!.subjectBinding, 'unbound'); assert.equal(candidate.run!.subject, undefined);
    assert.equal(candidate.run!.question, null); assert.equal(candidate.run!.subjectText, null);
    assert.equal(candidate.run!.pauseCode, code);
    assert.ok(text.includes('Логический вопрос: не закреплён — остановка до закрепления предмета плана'), text);
    assert.ok(!/Логический вопрос: (block|support)/.test(text));
  });

test('S6.9: a completed run with applied return/noProgress assessments keeps the stage researching — nothing is accepted', async t => {
  const f = await setup(t); f.configure([ended('refused'), ended()]);
  const run = await f.run(); assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
  assert.equal(f.store.list('research-attempt').length, 2);
  assert.equal(f.store.list('v7-progress-application').length, 2);
  for(const state of f.store.list('v7-progress-state')) {
    const proof=readV7ProgressStateAt(f.open(),reference(state));
    assert.deepEqual(proof.value.subject.planAnswer,f.v.planAnswer);
  }
  for (const state of f.store.list<any>('v7-progress-state')) {
    assert.equal(state.value.summary.count, 1); assert.equal(state.value.summary.streak, 1);
  }
  const { summary, candidate, text } = f.cold();
  assert.equal(summary.accepted, null, 'no accepted Discovery appears');
  assert.equal(candidate.state, 'researching'); assert.equal(candidate.run!.status, 'completed');
  assert.equal(candidate.run!.subjectBinding, undefined, 'a completed run has no stop to bind');
  assert.ok(text.includes('Исход: исследование не завершено') && text.includes('Принятый результат: ещё не принято.'), text);
  assert.ok(!text.includes('Логический вопрос'));
});

for (const damage of ['pause reason', 'pause turn subject', 'run turn count', 'owner question'] as const)
  test(`S6.9: a damaged ${damage} is an addressed runFailure, never a plausible question`, async t => {
    const owner = damage === 'owner question';
    const f = await setup(t, owner ? [planQuestion('block', 'industry', 'blocking')] : undefined);
    if (owner) {
      const source = f.discovery.evidence.document('p', 'owner-research', 'The owner chooses a jurisdiction.', 'text/plain', 0), ref = reference(source);
      f.configure([{ action: 'read_source', source: ref, start: 0, end: source.value.content.length },
        { action: 'need_owner', question: '$selected', reason: 'Choose a jurisdiction', searched: [ref] },
        { necessary: true, reason: 'Jurisdiction must be chosen by the owner' }]);
    } else f.configure([ended(), pause('Need the regional retention act')]);
    const run = await f.run(); assert.equal(run.value.status, owner ? 'needs_owner' : 'paused', JSON.stringify(run.value));
    // A deliberate negative forgery of the saved basis — never a producer's record.
    if (damage === 'pause reason') f.store.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, error: 'Another reason' } });
    if (damage === 'run turn count') f.store.write({ id: run.id, kind: run.kind, expected: run.revision, value: { ...run.value, turns: run.value.turns + 1 } });
    if (damage === 'owner question') f.store.write({ id: run.id, kind: run.kind, expected: run.revision,
      value: { ...run.value, ownerQuestion: { ...run.value.ownerQuestion!, question: 'support' } } });
    if (damage === 'pause turn subject') {
      const last = turns(f.store).at(-1)!;
      f.store.write({ id: last.id, kind: last.kind, expected: last.revision, value: { ...last.value, subject: { ...last.value.subject, planQuestionId: 'block' } } });
    }
    const { candidate, text } = f.cold();
    assert.equal(candidate.run, null, 'no plausible run question');
    assert.ok(candidate.runFailure, 'an addressed run failure');
    const expected = { 'pause reason': 'research_stop_subject_invalid', 'run turn count': 'research_stop_subject_invalid',
      'owner question': 'research_owner_question_invalid', 'pause turn subject': 'research_consumer_intent_invalid' }[damage];
    assert.equal(candidate.runFailure!.code, expected, JSON.stringify(candidate.runFailure));
    assert.ok(text.includes(`Отказ чтения запуска кандидата ${expected}`), text);
    assert.ok(!text.includes('Логический вопрос'));
  });


test('S6.9: an unpaid assessment pause keeps the finished K and an unbound logical question without accepting Discovery', async t => {
  const f=await setup(t),write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut&&writes.some(w=>w.kind==='assessment-session')){cut=true;throw new Error('Before unpaid assessor');}
    return write(writes,guards);
  }) as Store['writeMany'];
  await f.run();f.store.writeMany=write;assert.ok(cut);
  const calls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger'),wire=f.wires();
  const run=await f.run(8,f.open(),false);
  assert.equal(run.value.status,'paused');assert.equal(run.value.pauseCode,'research_assessment_pending');
  assert.equal(f.store.list('research-attempt').length,1);assert.equal(f.store.list('research-attempt-binding').length,1);
  assert.equal(f.store.list('v7-progress-application').length,0);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  const {summary,candidate,text}=f.cold();
  assert.equal(summary.accepted,null);assert.equal(candidate.state,'researching');
  assert.equal(candidate.run!.subjectBinding,'unbound');assert.equal(candidate.run!.pauseCode,'research_assessment_pending');
  assert.ok(text.includes('Логический вопрос: не закреплён'),text);
  assert.ok(!text.includes('Логический вопрос: block')&&!text.includes('Логический вопрос: support'),text);
  const history=()=>f.store.list().flatMap(row=>f.store.history(row.id).map(reference));
  const fixed=history();assert.deepEqual(await f.run(8,f.open(),false),run);
  f.cold();assert.deepEqual(history(),fixed);assert.equal(f.wires(),wire);
  assert.deepEqual(f.store.list('model-call'),calls);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
});
