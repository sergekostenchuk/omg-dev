import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoveryFixture, validFrame, planQuestion, fixturePlanCoverage } from './discovery-v7-fixture.js';
import { reference } from '../src/pipeline/contracts.js';
import { createPartialV7Draft, V7_AXES } from '../src/discovery/v7-contracts.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { executionAdmission } from '../src/discovery/projection-reader.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { ProductEngine } from '../src/product/engine.js';
import { withInvocationAllowanceReport } from '../src/discovery/invocation-progress.js';
import { ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { issueInterpretationChoiceInvitation, InterpretationChoiceSessions, chooseInterpretation } from '../src/product/interpretation-authority.js';
import type { Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../src/storage/store.js';

const policy = { discovery: 7 } as const;
const brief = '  Учёт ресурсов: материалы, техника и расчёты с подрядом.\nЧасть ERP компании: обмен с 1С и правила доступа. α  ';
const objective = 'Снизить потери на 20% и сохранить сверку техники и расчётов';
async function fixture(t: TestContext, missingObjective = false,
  outcome: 'no_divergence' | 'material' = 'no_divergence', mode: 'questions' | 'bypass' = 'questions') {
  const f = discoveryFixture(t, 'omg-b0-entry-', true), wire = join(f.root, 'wire.ndjson');
  const settings = join(f.root, 'scenario.json'), adapter = join(f.root, 'adapter.mjs');
  const frame: any = validFrame();
  for (const axis of V7_AXES) frame.axes[axis].reason = `Deep research for ${axis} in the complete ERP mandate`;
  const questions = V7_AXES.map(axis => planQuestion(`q-${axis}`, axis, ['rules', 'feasibility'].includes(axis) ? 'blocking' : 'supporting'));
  const coverage = fixturePlanCoverage(questions);
  writeFileSync(settings, JSON.stringify({ frame, questions, coverage, outcome }));
  writeFileSync(wire, '');
  writeFileSync(adapter, `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject.request?.interpretationPhase?{...r.subject,...r.subject.request}:r.subject,s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research={action:'pause',reason:'Calibration'};
if(c.interpretationPhase==='generate') {
 const q=c.frameRequest;
 research={contract:'frame-interpretations/v1',projectId:q.project,brief:q.brief,frame:q.frame,previousSet:q.previousSet,
 outcome:s.outcome,reason:'Exact inventory boundaries have different consequences',interpretations:s.outcome==='material'?[
 {id:'central',meaning:'One shared ledger',consequences:[{affects:'boundaries',text:'All sites share accounting'}],support:[q.brief.selector]},
 {id:'local',meaning:'Per-site ledgers',consequences:[{affects:'acceptance',text:'Reconcile each site independently'}],support:[q.brief.selector]}]:[]};
} else if(c.interpretationPhase==='choose') research={action:'choose',interpretation:'local',justification:'Reconcile every site'};
else if(c.interpretationPhase==='frame') research={action:'frame',decision:c.decisionRef,value:{...c.frameRequest.subject.frame.record.value.value,scale:'Applied local interpretation'}};
else if(c.role==='assess-answer') {
 const field=c.question.field;
 research={verdict:s.reject===field?'insufficient':'supported',reasons:s.reject===field?['Correct the missing owner scope']:[]};
} else if(c.request?.contract==='discovery-entry/v1') {
 const q=c.questions[0];
 let value=q.field==='frame'?s.frame:{edition:1,previous:null,frame:c.request.frame.answer,questions:s.questions,coverage:s.coverage};
 research={action:'answer',question:q.id,value,citations:[{source:c.request.brief.observation.source,selector:c.request.brief.observation.selector}]};
} else if(c.question?.id) research={action:'answer',question:c.question.id,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  f.engine.execute({ type: 'create-project', project: 'p', title: 'B0' });
  const modes = new ProjectModeSessions(f.store), scope = { project: 'p', mode, previous: null };
  const invitation = issueProjectModeInvitation(f.store, scope); assert.ok(invitation.ok);
  const session = modes.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(session.ok);
  setProjectMode(f.store, scope, modes.authority(session.value.bearer)); modes.revoke(session.value.bearer);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 20_000 }, 0);
  const probe = f.discovery.create('p', 'discovery', 'R0', 'concept', [
    { field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'string' } }], [], 6);
  for (const purpose of ['analyst', 'assessor'] as const)
    await researchCall(environment.value[purpose === 'analyst' ? 'implementer' : 'reviewer'], environment.value,
      'Calibrate', {}, undefined, { store: f.store, draftId: probe.id, questionId: probe.value.questions[0]!, purpose });
  const draft = createPartialV7Draft(f.discovery, 'p', 'concept');
  const q = (field: string, store = f.store) => draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === field)!;
  const source = f.discovery.evidence.document('p', 'owner-brief', brief, 'text/plain', 0);
  f.discovery.fact(q('brief').id, q('brief').revision, reference(source), { kind: 'text-range', start: 0, end: brief.length });
  if (!missingObjective) f.discovery.decision(q('objective').id, q('objective').revision, 'owner', objective);
  const sent = (): any[] => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).slice(2);
  const run = (limit: number, engine = f.engine, restoreOnly = false) => engine.researcher.run('p', draft.id, limit, undefined,
    { producerPolicy: policy, ...(restoreOnly ? { restoreOnly } : {}) });
  return { ...f, draft, q, sent, run,
    own: (generation: Ref, store = f.store) => {
      const scope = { project: 'p', generation, interpretation: 'local', justification: 'Keep each site accountable' };
      const sessions = new InterpretationChoiceSessions(store), session = sessions.exchange(issueInterpretationChoiceInvitation(store, scope));
      try { return chooseInterpretation(store, scope, session.authority); }
      finally { sessions.revoke(session.bearer); }
    },
    correct: (field: string) => {
      if (field === 'frame') frame.scale += '; all materials, equipment and settlements remain in scope';
      else questions[0]!.criterion += '; preserve every part of the original mandate';
      writeFileSync(settings, JSON.stringify({ frame, questions, coverage, outcome }));
    },
    reject: (field: string | null) => writeFileSync(settings, JSON.stringify({ frame, questions, coverage, outcome, reject: field })) };
}

test('B0: an ordinary run pays for supported frame/plan and reaches the first research attempt', { timeout: 60_000 }, async t => {
  const f = await fixture(t), result = await f.run(6);
  assert.equal(f.q('frame').value.status, 'answered', JSON.stringify(result.value));
  assert.equal(f.q('plan').value.status, 'answered', JSON.stringify(result.value));
  const sent = f.sent();
  assert.equal(sent.length, 6, JSON.stringify(result.value));
  assert.equal(sent[0].subject.request.brief.value, brief);
  assert.equal(sent[0].subject.request.objective.value, objective);
  assert.equal(sent[1].subject.v7Frame.brief.value, brief);
  assert.equal(sent[2].subject.request.interpretationPhase, 'generate');
  assert.deepEqual(sent[3].subject.request.frame.answer, f.q('frame').value.answer);
  assert.equal(sent[4].subject.question.field, 'plan');
  assert.equal(sent[4].subject.planBasis.mandate.value, brief);
  assert.deepEqual(sent[4].subject.planBasis.frame.answer, f.q('frame').value.answer);
  assert.ok(sent[5].subject.question.id.startsWith('q-'), JSON.stringify(sent[5].subject));
  const current = f.store.get<DiscoveryDraft>(f.draft.id)!;
  assert.equal(executionAdmission(f.store, current, 'stage-result', policy).admitted, false,
    'A paid accepted plan is not a final discovery result');
});

test('B0: rejected frame or plan stays open; a changed proposal can continue', { timeout: 60_000 }, async t => {
  for (const field of ['frame', 'plan']) {
    const f = await fixture(t); f.reject(field);
    const result = await f.run(field === 'frame' ? 2 : 5);
    assert.equal(f.q(field).value.status, 'open', JSON.stringify(result.value));
    assert.equal(f.q(field).value.answer, null);
    assert.equal(f.sent().some(r => r.subject.question?.id?.startsWith('q-')), false);
    assert.ok(f.store.list<any>('research-assessment').some(row => row.value.verdict === 'insufficient'));
    f.correct(field);
    const corrected = await f.run(2);
    assert.equal(f.q(field).value.status, 'answered', JSON.stringify(corrected.value));
  }
});

test('B0: one rejected proposal cannot repeatedly buy the same assessment', { timeout: 60_000 }, async t => {
  const f = await fixture(t); f.reject('frame');
  const result = await f.run(8);
  assert.equal(f.q('frame').value.status, 'open');
  assert.equal(result.value.pauseCode, 'research_no_progress', JSON.stringify(result.value));
  assert.equal(f.sent().filter(r => r.subject.role === 'assess-answer').length, 1);
  const count = f.sent().length; await f.run(8);
  assert.equal(f.sent().length, count, 'Restart cannot buy the rejected repeated pending proposal again');
});

test('B0: missing accepted owner objective is named and costs no model call', { timeout: 60_000 }, async t => {
  const f = await fixture(t, true), result = await f.run(5);
  assert.equal(result.value.status, 'needs_owner', JSON.stringify(result.value));
  assert.equal(result.value.ownerQuestion?.question, f.q('objective').id);
  assert.equal(result.value.pauseCode, 'research_owner_input_missing');
  const driver = new EarlyStageDriver(f.engine, undefined, policy);
  const driven = await driver.run({ project: 'p', draftId: f.draft.id, maxTurns: 5, maxCalls: 5 });
  assert.equal(driven.reason?.code, 'research_owner_input_missing', JSON.stringify(driven));
  assert.equal(f.sent().length, 0);
});

test('B0: Driver maxCalls is shared by author and assessor; cold continuation pays only the next step', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  let engine = f.engine;
  for (const limit of [1, 2, 1, 1, 1]) {
    const before = f.sent().length;
    const result = await new EarlyStageDriver(engine, undefined, policy).run({ project: 'p', draftId: f.draft.id, maxTurns: 10, maxCalls: limit });
    assert.equal(f.sent().length - before, limit, JSON.stringify(result));
    assert.equal(result.budget.callsMade, limit, JSON.stringify(result));
    assert.equal(result.budget.callsRemaining, 0);
    engine = new ProductEngine(f.open());
  }
  assert.equal(f.q('frame', engine.store).value.status, 'answered');
  assert.equal(f.q('plan', engine.store).value.status, 'answered');
  assert.equal(f.sent().filter(r => r.subject.request?.contract === 'discovery-entry/v1').length, 2);
});

test('B0: a smaller research limit consumes the outer allowance once per physical call', { timeout: 60_000 }, async t => {
  const f = await fixture(t), result = await withInvocationAllowanceReport(10, () => f.run(2));
  assert.equal(f.sent().length, 2, JSON.stringify(result.value.value));
  assert.equal(result.used, 2); assert.equal(result.remaining, 8);
  assert.equal(f.q('frame').value.status, 'answered');
  assert.equal(f.q('plan').value.status, 'open');
});

test('B0: StageResearch captures the trusted policy once for admission and dispatch', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  let reads = 0;
  const options = { get producerPolicy() { return ++reads === 1 ? policy : { discovery: 6 }; } };
  const result = await f.engine.stageResearch.run('p', f.draft.id, 1, options);
  assert.equal(reads, 1);
  assert.equal(result.status, 'paused');
  assert.equal(f.sent().length, 1, JSON.stringify(result));
  assert.equal(f.q('frame').value.status, 'open');
  assert.equal(f.q('plan').value.status, 'open');
});

test('B0: restoreOnly settles paid work without opening a new physical call', { timeout: 60_000 }, async t => {
  const f = await fixture(t); await f.run(1);
  assert.equal(f.sent().length, 1);
  const cold = new ProductEngine(f.open());
  await f.run(5, cold, true);
  assert.equal(f.sent().length, 1);
  assert.equal(f.q('frame', cold.store).value.status, 'open');
  await f.run(4, cold);
  assert.equal(f.sent().length, 5);
  assert.equal(f.q('plan', cold.store).value.status, 'answered');
});

test('B0+D1: material stops the ordinary Driver until scoped owner choice, then plans against the applied frame', { timeout: 60_000 }, async t => {
  const f = await fixture(t, false, 'material', 'questions');
  const first = await new EarlyStageDriver(f.engine, undefined, policy).run({ project: 'p', draftId: f.draft.id, maxTurns: 10, maxCalls: 3 });
  assert.equal(first.end, 'needs_owner', JSON.stringify(first));
  assert.equal(first.reason?.code, 'interpretation_owner_required');
  assert.equal(first.budget.callsMade, 3);
  assert.equal(f.q('plan').value.status, 'open');
  const originalFrame = f.q('frame').value.answer;
  const run = f.store.list<any>('research-run').find(r => r.value.draftId === f.draft.id)!;
  const generation = run.value.entryInterpretation.continuation.generation;
  const cold = new ProductEngine(f.open());
  const waiting = await f.run(10, cold);
  assert.equal(waiting.value.status, 'needs_owner');
  assert.equal(f.sent().length, 3, 'Unanswered scoped choice cannot buy another generation or a plan');
  f.own(generation, cold.store);
  const done = await new EarlyStageDriver(cold, undefined, policy).run({ project: 'p', draftId: f.draft.id, maxTurns: 10, maxCalls: 5 });
  assert.equal(done.budget.callsMade, 5, JSON.stringify(done));
  assert.equal(f.sent().length, 8);
  assert.notDeepEqual(f.q('frame', cold.store).value.answer, originalFrame);
  assert.equal(f.q('plan', cold.store).value.status, 'answered');
  const planRequest = f.sent().find(r => r.subject.request?.contract === 'discovery-entry/v1' && r.subject.questions[0].field === 'plan');
  assert.deepEqual(planRequest.subject.request.frame.answer, f.q('frame', cold.store).value.answer);
  assert.equal(planRequest.subject.request.frame.value.scale, 'Applied local interpretation');
  assert.equal(f.sent().filter(r => r.subject.request?.interpretationPhase === 'generate').length, 1);
});

test('B0+D1: bypass and A2 share Driver maxCalls=1; restore after application cannot become a new frame author', { timeout: 60_000 }, async t => {
  const f = await fixture(t, false, 'material', 'bypass');
  let engine = f.engine;
  for (let step = 0; step < 9; step++) {
    const before = f.sent().length;
    const result = await new EarlyStageDriver(engine, undefined, policy).run({ project: 'p', draftId: f.draft.id, maxTurns: 10, maxCalls: 1 });
    assert.equal(f.sent().length - before, 1, `step ${step}: ${JSON.stringify(result)}`);
    assert.equal(result.budget.callsMade, 1);
    engine = new ProductEngine(f.open());
    if (step === 4) {
      assert.equal(f.q('frame', engine.store).value.status, 'open');
      assert.equal(f.q('plan', engine.store).value.status, 'open');
      await f.run(10, engine, true);
      assert.equal(f.sent().length, before + 1, 'Only the paid proposal/application may restore; A2 is still unpaid');
      assert.equal(f.q('frame', engine.store).value.status, 'open');
    }
  }
  assert.equal(f.q('plan', engine.store).value.status, 'answered');
  assert.equal(f.sent().filter(r => r.subject.request?.interpretationPhase === 'generate').length, 1);
  assert.equal(f.sent().filter(r => r.subject.request?.interpretationPhase === 'choose').length, 1);
  assert.equal(f.sent().filter(r => r.subject.request?.contract === 'discovery-entry/v1' && r.subject.questions[0].field === 'frame').length, 1);
});

test('B0+D1: a cut before recording ready restores the real proof without repurchasing or starting the plan', { timeout: 60_000 }, async t => {
  const f = await fixture(t, false, 'material', 'bypass'), write = Store.prototype.writeMany;
  let cut = false;
  // Keep genuine reads and their proof cache while cutting only this Store's write.
  Store.prototype.writeMany = function<T>(writes: Write[], guards: TransactionGuard[] = []): Revision<T>[] {
    if (this === f.store && !cut && writes.some(w => w.kind === 'research-run' && (w.value as any).entryInterpretation?.ready)) {
      cut = true; throw new Error('Cut before recording real D1 readiness');
    }
    return write.call(this, writes, guards) as Revision<T>[];
  };
  try { await f.run(6); } finally { Store.prototype.writeMany = write; }
  assert.equal(cut, true);
  assert.equal(f.sent().length, 6);
  assert.equal(f.q('frame').value.status, 'answered');
  assert.equal(f.q('plan').value.status, 'open');
  const cold = new ProductEngine(f.open());
  await f.run(10, cold, true);
  assert.equal(f.sent().length, 6);
  assert.equal(f.q('plan', cold.store).value.status, 'open');
  const result = await f.run(3, cold);
  assert.equal(f.sent().length, 9, JSON.stringify(result.value));
  assert.equal(f.q('plan', cold.store).value.status, 'answered');
});

test('B0+D1: a reopened owner input cannot fund the prepared interpretation boundary', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await f.run(2);
  assert.equal(f.q('frame').value.status, 'answered');
  assert.equal(f.sent().length, 2);
  const q = f.q('objective'); f.discovery.reopen(q.id, q.revision);
  const result = await f.run(10, new ProductEngine(f.open()));
  assert.equal(result.value.status, 'needs_owner', JSON.stringify(result.value));
  assert.equal(result.value.pauseCode, 'research_owner_input_missing');
  assert.equal(result.value.ownerQuestion?.question, q.id);
  assert.equal(f.sent().length, 2);
  assert.equal(f.q('plan').value.status, 'open');
});
