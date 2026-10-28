import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { EngineError } from '../src/errors.js';
import { reference } from '../src/pipeline/contracts.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { researchPrerequisites } from '../src/discovery/research-context.js';
import { assessAnswer, readResearchAssessmentAt } from '../src/discovery/research-assessment.js';
import { researchCall, researchAction } from '../src/discovery/research-protocol.js';
import { createPartialV7Draft, V7_AXES } from '../src/discovery/v7-contracts.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';
import { readV7PlanBasis } from '../src/discovery/v7-plan-assessment.js';
import { discoveryFixture, questionOf, validFrame, validPlan, planQuestion } from './discovery-v7-fixture.js';
import { DatabaseSync } from 'node:sqlite';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import type { Store } from '../src/storage/store.js';
const brief = '  Построить систему снабжения 30 площадок.\nСохранить правила организации и измеримый итог.\nИсследовать все оси, аналоги пока не проверены. 🧭  ';
const snapshot = (store: Store) => {
  const db = new DatabaseSync(store.path, { readOnly: true });
  try { return canonical({ heads: db.prepare('SELECT * FROM heads ORDER BY entity_id').all(),
    history: db.prepare('SELECT * FROM revisions ORDER BY entity_id, revision').all(),
    events: db.prepare('SELECT * FROM events ORDER BY sequence').all() } as never); }
  finally { db.close(); }
};

async function setup(t: test.TestContext, inapplicable = false, large = false) {
  const mandate = inapplicable ? brief.replace('Исследовать все оси,', 'Платежи и бухгалтерия явно вне поручения; учёт только наличия и перемещения запасов. Исследовать остальные оси,') : brief;
  const f = discoveryFixture(t, 'omg-a3-paid-', true);
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Plan coverage' });
  const wire = join(f.root, 'wire.ndjson'), settings = join(f.root, 'settings.json'), adapter = join(f.root, 'adapter.mjs');
  writeFileSync(wire, ''); writeFileSync(settings, JSON.stringify({ verdict: 'supported', reasons: [] }));
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research=s.action && !r.subject.candidatePage ? s.action : {verdict:s.verdict,reasons:s.reasons};
if(r.subject.candidatePage && (r.subject.candidatePage?.complete===false || r.subject.evidencePage?.complete===false))
 research={action:'assessment_checkpoint',notes:['Read the next exact candidate and evidence page']};
else if(r.subject.candidatePage){
 const previous=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));
 for(const a of r.subject.working?.materialAddresses??[]){
  const fragments=previous.flatMap(row=>[...(row.subject.materialDelivery??[]),...(row.subject.contextDelivery??[])])
   .filter(d=>d.original?.record?.id===a.record.id&&d.original.pointer===a.pointer);
  const pages=previous.flatMap(row=>row.subject.contextWorkspace??[]).filter(x=>x.record?.id===a.record.id&&x.pointer===a.pointer);
  const direct=pages.find(x=>x.page?.next==null);
  const offset=Math.max(0,...fragments.map(d=>d.served.end),...pages.map(x=>x.page?.end??0));
  if(!direct&&offset<a.total){research={action:'read_context',record:a.record,pointer:a.pointer,page:{offset,limit:2048,encoding:'canonical-json'}};break;}
 }
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000,
    ...(large ? { requestCapacityChars: 60000 } : {}) }, 0);
  const cal = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor'] as const) await researchCall(environment.value[purpose === 'analyst' ? 'implementer' : 'reviewer'], environment.value,
    'Calibrate', {}, undefined, { store: f.store, draftId: cal.id, questionId: cal.value.questions[0]!, purpose });
  const draft = createPartialV7Draft(f.discovery, 'p', 'concept');
  const source = f.discovery.evidence.document('p', 'mandate', mandate, 'text/plain', 0);
  const b = questionOf(f.store, draft, 'brief'); f.discovery.fact(b.id, b.revision, reference(source), { kind: 'text-range', start: 0, end: mandate.length });
  const o = questionOf(f.store, draft, 'objective'); f.discovery.decision(o.id, o.revision, 'owner', 'Проверяемая поставка материалов на 30 площадках');
  const frame: any = validFrame();
  if (large) frame.scale += ' Original requirements of each construction site: stock, deliveries, personnel. '.repeat(480);
  const questions = V7_AXES.filter(axis => !inapplicable || axis !== 'money').map(axis => planQuestion(`q-${axis}`, axis,
    ['rules', 'feasibility'].includes(axis) ? 'blocking' : 'supporting'));
  if (inapplicable) frame.axes.money = { depth: 'inapplicable', reason: 'The owner explicitly excludes payment execution and accounting; this scope only records material availability and stock movements.' };
  const fq = questionOf(f.store, draft, 'frame');
  const action = (q: Question | { id: string }, value: Json): any => ({ action: 'answer', question: 'id' in q ? q.id : '', value,
    citations: [{ source: reference(source), selector: { kind: 'text-range', start: 0, end: mandate.length } }] });
  const fa = await assessAnswer(f.store, fq, action(fq, frame), environment, f.root);
  assert.equal(fa.value.verdict, 'supported'); f.discovery.researched(fq.id, fq.revision, reference(fa));
  const plan = questionOf(f.store, draft, 'plan');
  const candidate: any = validPlan(f.store.get<Question>(fq.id)!.value.answer!, questions);
  if (inapplicable) candidate.coverage.money = { inapplicable: frame.axes.money.reason };
  const configure = (patch: object) => writeFileSync(settings, JSON.stringify({ verdict: 'supported', reasons: [], ...patch }));
  const assess = (value: Json = candidate, db = f.store) => assessAnswer(db, db.get<Question>(plan.id)!, action(plan, value), environment, f.root);
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...f, draft, source, frame, fq, plan, candidate, environment, action, configure, assess, wires };
}

test('A3 paid plan: ordinary analyst transport produces, assesses and accepts full coverage from the exact frame and verbatim brief', async t => {
  const f = await setup(t); f.configure({ action: f.action(f.plan, f.candidate) });
  const current = f.store.get<DiscoveryDraft>(f.draft.id)!;
  const generated = researchAction(await researchCall(f.environment.value.implementer, f.environment.value, f.plan.value.spec.prompt,
    { role: 'research', stage: 'discovery', question: f.plan.value.spec, prerequisites: researchPrerequisites(f.store, current.value) }, undefined,
    { store: f.store, draftId: current.id, questionId: f.plan.id, purpose: 'analyst' }));
  assert.equal(generated.action, 'answer');
  if (generated.action !== 'answer') throw new Error('Expected a generated plan');
  const assessment = await assessAnswer(f.store, f.plan, generated, f.environment, f.root);
  f.discovery.researched(f.plan.id, f.plan.revision, reference(assessment));
  const q = f.store.get<Question>(f.plan.id)!;
  assert.equal(q.value.status, 'answered');
  const links = provePlanQuestions(f.store, f.store.get<DiscoveryDraft>(f.draft.id)!, q.value.answer!);
  assert.deepEqual(links.map(x => x.planQuestionId), V7_AXES.map(axis => `q-${axis}`));
  assert.ok(links.every(x => x.planAnswer.hash === q.value.answer!.hash));
  const sourceCalls = f.wires().filter(r => JSON.stringify(r).includes('v7-plan-basis/v1'));
  assert.ok(sourceCalls.length >= 2, 'Both producer and assessor receive the plan basis');
  const assessor = sourceCalls.find(r => r.subject.candidatePage);
  assert.ok(assessor); assert.ok(JSON.stringify(assessor).includes(JSON.stringify(brief).slice(1,-1)));
  assert.match(assessor.prompt, /generic excuse is insufficient/);
  assert.ok(f.store.list('research-budget-ledger').length > 0);
  const { directAssessmentBasis } = await import('../src/discovery/research-assessment.js');
  const briefQ = questionOf(f.store, f.store.get<DiscoveryDraft>(f.draft.id)!, 'brief');
  const opened = f.discovery.reopen(briefQ.id, briefQ.revision);
  const later = f.discovery.evidence.document('p', 'later-mandate', 'Later owner mandate', 'text/plain', 0);
  f.discovery.fact(opened.id, opened.revision, reference(later), { kind: 'text-range', start: 0, end: later.value.content.length });
  const before = snapshot(f.store), sent = f.wires();
  for (const db of [f.store, f.open()]) {
    assert.ok(directAssessmentBasis(db, assessment));
  }
  assert.deepEqual(provePlanQuestions(f.open(), f.store.get<DiscoveryDraft>(f.draft.id)!, q.value.answer!), links);
  assert.equal(snapshot(f.store), before); assert.deepEqual(f.wires(), sent);
});

test('A3 paid plan: specific inapplicability is assessed; generic reasons return insufficient and cannot be accepted', async t => {
  const f = await setup(t, true);
  const bad = structuredClone(f.candidate); bad.coverage.money.inapplicable = 'not applicable';
  f.configure({ verdict: 'insufficient', reasons: ['coverage.money: generic exclusion does not explain the accepted mandate'] });
  const rejected = await f.assess(bad); assert.equal(rejected.value.verdict, 'insufficient');
  assert.throws(() => f.discovery.researched(f.plan.id, f.plan.revision, reference(rejected)), EngineError);
  assert.equal(f.store.get<Question>(f.plan.id)!.value.status, 'open');
  f.configure({}); const accepted = await f.assess(); assert.equal(accepted.value.verdict, 'supported');
  f.discovery.researched(f.plan.id, f.plan.revision, reference(accepted));
  assert.deepEqual(f.store.get<DiscoveryDraft>(f.draft.id)!.value.fields['frame'], f.frame);
});

test('A3 paid plan: missing axis, disguised exclusion and shallow deep questions refuse before assessment payment', async t => {
  const f = await setup(t);
  const changes: Array<(p: any) => void> = [p => delete p.coverage.market,
    p => { p.questions = p.questions.filter((q: any) => q.axis !== 'market'); p.coverage.market = { inapplicable: 'Ignore market' }; },
    p => p.questions[0].requiredDepth = 'brief', p => p.coverage.industry.questions = ['q-market'],
    p => p.frame = reference(f.source)];
  for (const change of changes) {
    const value = structuredClone(f.candidate); change(value);
    const before = snapshot(f.store), sent = f.wires();
    await assert.rejects(() => f.assess(value), (e: unknown) => e instanceof EngineError && ['answer_invalid', 'plan_basis_invalid'].includes(e.code));
    assert.equal(snapshot(f.store), before); assert.deepEqual(f.wires(), sent);
  }
});

test('A3 paid plan: assessment insufficiency and contradiction stay open; current basis cannot be replaced by a caller marker', async t => {
  const f = await setup(t);
  for (const verdict of ['insufficient', 'conflicting']) {
    const candidate = structuredClone(f.candidate); candidate.questions[0].criterion = verdict === 'insufficient' ? 'Look briefly' : 'Contradict the owner objective';
    f.configure({ verdict, reasons: [`questions.q-industry: ${verdict}`] });
    const a = await f.assess(candidate); assert.equal(a.value.verdict, verdict);
    assert.throws(() => f.discovery.researched(f.plan.id, f.plan.revision, reference(a)), EngineError);
    assert.equal(f.store.get<Question>(f.plan.id)!.value.status, 'open');
  }
  const current = f.store.get<DiscoveryDraft>(f.draft.id)!;
  const basis = readV7PlanBasis(f.store, current.value, f.plan, f.candidate)!;
  assert.deepEqual(basis.context.frame.value, f.frame);
  assert.equal(basis.context.mandate.value, brief);
  const other = f.open(), d = new Discovery(other), frame = other.get<Question>(f.fq.id)!;
  d.reopen(frame.id, frame.revision);
  const before = snapshot(f.store), sent = f.wires();
  for (const db of [f.store, f.open()]) await assert.rejects(() => f.assess(f.candidate, db), (e: unknown) => e instanceof EngineError && e.code === 'plan_basis_invalid');
  assert.equal(snapshot(f.store), before); assert.deepEqual(f.wires(), sent);
});


test('A3 paid plan: a missing original Source refuses hot/cold before any model call or history write', async t => {
  const f = await setup(t);
  const db = new DatabaseSync(f.path);
  try { db.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER revisions_no_delete'); db.prepare('DELETE FROM revisions WHERE entity_id = ? AND revision = ?').run(f.source.id, f.source.revision); }
  finally { db.close(); }
  const before = snapshot(f.store), sent = f.wires();
  for (const store of [f.store, f.open()])
    await assert.rejects(() => f.assess(f.candidate, store), (e: unknown) => e instanceof EngineError);
  assert.equal(snapshot(f.store), before); assert.deepEqual(f.wires(), sent);
});


test('A3 paid plan: large exact basis uses bounded addressed delivery and survives a cold result read', async t => {
  const f = await setup(t, false, true);
  const assessment = await f.assess();
  assert.equal(assessment.value.verdict, 'supported');
  const sent = f.wires().filter(r => JSON.stringify(r).includes('planBasis'));
  assert.ok(sent.some(r => r.subject.working?.materialAddresses?.some((a: any) => a.field === 'planBasis')));
  assert.ok(sent.some(r => (r.subject.materialDelivery ?? []).some((d: any) => d.original.pointer === '/body/planBasis')
    || (r.subject.contextDelivery ?? []).some((d: any) => d.original.pointer === '/body/planBasis')));
  const { directAssessmentBasis } = await import('../src/discovery/research-assessment.js');
  const before = snapshot(f.store), wires = f.wires();
  assert.ok(directAssessmentBasis(f.open(), assessment));
  assert.equal(snapshot(f.store), before); assert.deepEqual(f.wires(), wires);
  assert.ok(sent.filter(r => r.subject.candidatePage).length > 1, 'The bounded assessor really continued on later paid pages');
  const tooSmall = f.engine.environments.configure('p', { ...f.environment.value, requestCapacityChars: 2000 }, f.environment.revision);
  const calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger'), sentBefore = f.wires();
  const next = structuredClone(f.candidate); next.questions[0].criterion += ' with a second measurable threshold';
  await assert.rejects(() => assessAnswer(f.store, f.store.get<Question>(f.plan.id)!, f.action(f.plan, next), tooSmall, f.root),
    (e: unknown) => e instanceof EngineError && e.code === 'research_capacity_configuration');
  assert.deepEqual(f.store.list('model-call'), calls); assert.deepEqual(f.store.list('research-budget-ledger'), ledger); assert.deepEqual(f.wires(), sentBefore);
});


test('A3 plan basis: malformed and disguised saved questions fail with typed errors without writes', async t => {
  const f = await setup(t), draft = f.store.get<DiscoveryDraft>(f.draft.id)!;
  const before = snapshot(f.store), sent = f.wires();
  for (const value of [null, [], 'text', 0, true, { ...f.plan.value, prompt: 'forged' }]) {
    const question = { ...f.plan, value, hash: hashJson(value) } as unknown as typeof f.plan;
    assert.throws(() => readV7PlanBasis(f.store, draft.value, question, f.candidate),
      (error: unknown) => error instanceof EngineError && error.code === 'plan_basis_invalid');
  }
  for (const field of ['questions', 'fields'] as const) {
    const incomplete = { ...draft.value, [field]: null } as unknown as DiscoveryDraft;
    assert.throws(() => readV7PlanBasis(f.store, incomplete, f.plan), { code: 'plan_basis_invalid' });
  }
  assert.equal(snapshot(f.store), before); assert.deepEqual(f.wires(), sent);
});

test('A3 plan basis: second Store reopening the frame at preparation or acceptance cannot cross the atomic guard', async t => {
  for (const phase of ['prepare', 'accept'] as const) {
    const f = await setup(t), assessment = phase === 'accept' ? await f.assess() : null;
    const original = f.store.writeMany.bind(f.store), other = f.open(), discovery = new Discovery(other);
    let changed = false, afterOwner = '';
    const sent = f.wires(), calls = f.store.list('model-call'), ledger = f.store.list('research-budget-ledger');
    f.store.writeMany = ((writes, guards) => {
      if (!changed && writes.some(w => w.kind === (phase === 'accept' ? 'research-answer' : 'assessment-application'))) {
        changed = true;
        const frame = other.get<Question>(f.fq.id)!; discovery.reopen(frame.id, frame.revision);
        afterOwner = snapshot(f.store);
      }
      return original(writes, guards);
    }) as Store['writeMany'];
    try {
      if (phase === 'accept') assert.throws(() => f.discovery.researched(f.plan.id, f.plan.revision, reference(assessment!)), { code: 'input_stale' });
      else await assert.rejects(() => f.assess(), { code: 'input_stale' });
    } finally { delete (f.store as unknown as { writeMany?: unknown }).writeMany; }
    assert.equal(changed, true, phase);
    assert.equal(snapshot(f.store), afterOwner); assert.deepEqual(f.wires(), sent);
    assert.deepEqual(f.store.list('model-call'), calls); assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
    assert.equal(f.store.get<Question>(f.plan.id)!.value.status, 'open');
  }
});


test('A3 paid plan: managed historical reader reproduces the exact plan assessor instruction hot and cold', async t => {
  const f = await setup(t), draft = f.store.get<DiscoveryDraft>(f.draft.id)!, question = f.plan;
  const context = { role: 'research', stage: 'discovery', question: question.value.spec,
    prerequisites: researchPrerequisites(f.store, draft.value) };
  // Only the initial empty run is a fixture; intent, physical reply, turn and assessment use their producers.
  const run = f.store.write<ResearchRun>({ id: 'research-run:a3-plan', kind: 'research-run', expected: 0,
    value: { projectId: 'p', draftId: draft.id, environment: reference(f.environment), turns: 0, limit: 1, requestChars: 0,
      owner: { pid: process.pid, started: processStart(process.pid)! }, ownerQuestion: null, error: null,
      status: 'running', inputs: draft.value.inputs } });
  const prompt = question.value.spec.prompt;
  const intent = prepareResearchConsumerIntent(f.store, { projectId: 'p', kind: 'analyst', key: run.id,
    owner: reference(run), draft: reference(draft), question: reference(question), role: f.environment.value.implementer,
    dispatch: f.environment.value, profile: null, cursor: { run: run.id, turn: 1, instruction: prompt, context },
    basis: draft.value.inputs, guards: uniqueTransactionGuards([reference(run), reference(draft), reference(question), reference(f.environment)]) });
  f.configure({ action: f.action(question, f.candidate) });
  const response = await researchCall(f.environment.value.implementer, f.environment.value, prompt, context, undefined,
    { store: f.store, draftId: draft.id, questionId: question.id, purpose: 'analyst', consumerIntent: reference(intent) });
  const execution = readResearchConsumerExecution(f.store, 'p', reference(intent)); assert.equal(execution.kind, 'response');
  const projected = projectPaidTurnAdmission(run.value, { runId: run.id, intent: reference(intent), response,
    question: reference(question), owner: run.value.owner, limit: 1, context });
  const turnId = managedTurnId(run.id, 1);
  const application = prepareResearchConsumerApplication(f.store, reference(intent), reference(execution.call), [
    { id: run.id, kind: run.kind, expected: run.revision, value: projected.run },
    { id: turnId, kind: 'research-turn', expected: 0, value: projected.turn }],
    [reference(run), reference(f.environment), { id: turnId, absent: true }]);
  f.store.writeMany(application.writes, application.guards);
  const action = researchAction(response); assert.equal(action.action, 'answer');
  if (action.action !== 'answer') throw new Error('Expected the paid plan proposal');
  const assessment = await assessAnswer(f.store, question, action, f.environment, f.root, undefined, undefined,
    reference(f.store.get(turnId)!));
  assert.equal(assessment.value.verdict, 'supported');
  const packets = f.wires().filter(r => r.subject.candidatePage && JSON.stringify(r).includes('v7-plan-basis/v1'));
  assert.ok(packets.length); assert.ok(packets.every(r => r.prompt.includes('generic excuse is insufficient')));
  const before = snapshot(f.store), sent = f.wires();
  for (const db of [f.store, f.open()]) {
    assert.deepEqual(readResearchAssessmentAt(db, 'p', turnId, reference(assessment)), assessment);
  }
  assert.equal(snapshot(f.store), before); assert.deepEqual(f.wires(), sent);
  const briefQ = questionOf(f.store, draft, 'brief');
  f.discovery.reopen(briefQ.id, briefQ.revision);
  const later = snapshot(f.store);
  assert.deepEqual(readResearchAssessmentAt(f.open(), 'p', turnId, reference(assessment)), assessment);
  assert.equal(snapshot(f.store), later); assert.deepEqual(f.wires(), sent);
});
