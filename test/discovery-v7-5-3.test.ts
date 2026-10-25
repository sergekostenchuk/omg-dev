import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store } from '../src/storage/store.js';
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
import { runVariantSession,
  type VariantSessionInput } from '../src/discovery/variant-session.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA,
  type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId, VARIANT_OWNER_ACTION,
  type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { ProjectModeSessions, VariantChoiceSessions, issueProjectModeInvitation, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';
import type { OmResult } from '../src/om/refusal.js';

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
async function paid(t: test.TestContext, answer: unknown = generation()) {
  const f = await researchSetup(t, { adapter: 'reply', prefix: 'omg-5-5-' }), project = 'p', runs = new Map<string, string>();
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
    const entry = await produce(g, undefined, question), packet = projectAttemptPacket(f.store, { project, planAnswer: f.v.planAnswer, planQuestionId: question, entries: [entry] });
    const reply = { verdict: 'supported', reasons: ['Paid sweep'], return: null, novelty: { attempts: [{ attempt: entry.attempt, reason: 'Exact result' }], accepted: [], rejected: [], newContent: [], duplicates: [], noProgress: [{ attempt: entry.attempt, reason: 'No source' }], transition: null },
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
  reply(answer);
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

import { DISCOVERY_DEEP_PREPARATION_CONTRACT,
  produceDeepPreparation, type DeepPreparation } from '../src/discovery/deep-research.js';
import { DISCOVERY_COVERAGE_CELL_CONTRACT } from '../src/discovery/coverage.js';
import { V7_PLAN_SUBJECT_CONTRACT } from '../src/discovery/v7-managed-attempt.js';
import { provePlanQuestions } from '../src/discovery/v7-plan-questions.js';

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
import { prepareDeepResearch, runDeepResearch } from '../src/discovery/deep-research-execution.js';
const all = (store: Store) => canonical(store.list().flatMap(row => store.history(row.id)));
const end = { type: 'impossible', code: 'source_unavailable', evidence: [], text: 'No accessible source for this exact cell' };
async function ready(t: test.TestContext, model = false) {
  const f = await paid(t);
  let scope: ReturnType<typeof publishVariantScope>['scope'];
  if (model) { const choice = await modelChoose(f); scope = publishVariantScope(f.store, 'p', reference(choice)).scope; }
  else scope = selected(f).published;
  const preparation = produceDeepPreparation(f.store, 'p', inputFor(f, scope)).record;
  f.reply({ action: 'answer', question: 'q-industry', value: end, citations: [] });
  const input = { projectId: 'p', deepPreparation: reference(preparation), environment: f.environment };
  return { ...f, scopeRecord: scope, preparation, input };
}
import { consumerIntentContext } from '../src/discovery/response-recovery.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';
import { prepareResearchEnvelope } from '../src/discovery/research-protocol.js';

test('5.3 managed deep carries full exact cell, scope and preparation through capacity, archive, continuation and physical wire',async t=>{
  const f=await ready(t),intent=prepareDeepResearch(f.store,f.input),context=consumerIntentContext(f.store,intent.value);
  assert.deepEqual(intent.value.cursor.resultCapacity.bindings.deepPreparation,reference(f.preparation));
  const result=(await runDeepResearch(f.store,f.input))!,wire=f.wires().at(-1)!.subject;
  const archive=f.store.get<any>(result.archive.id,result.archive.revision)!;
  const body=readArchiveBody(f.store,archive).body;
  for(const actual of [context,body,wire]){
    assert.deepEqual(actual.deepPreparation,reference(f.preparation));
    assert.deepEqual(actual.deepCell,f.preparation.value.cell);
    assert.deepEqual(actual.deepScope,f.scopeRecord.value);
  }
  assert.deepEqual((result.call.value as any).deepPreparation,reference(f.preparation));
  assert.deepEqual((f.store.get<any>(result.call.id,1)!.value).deepPreparation,reference(f.preparation));
  const state=f.store.list<any>('continuation-state').find(r=>canonical(r.value.deepPreparation??null)===canonical(reference(f.preparation)));
  assert.ok(state);assert.deepEqual(state.value.subject,f.preparation.value.cell.subject);
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length;
  assert.deepEqual(await runDeepResearch(f.store,f.input,{restoreOnly:true,allowance:0}),result);
  assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
});

test('5.3 explicit null, missing or substituted carrier fields and capacity refuse without dispatch or writes',async t=>{
  const f=await ready(t),intent=prepareDeepResearch(f.store,f.input),context=consumerIntentContext(f.store,intent.value);
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length;
  for(const change of [{deepPreparation:null},{deepPreparation:{id:'x'}},{deepPreparation:reference(f.set!)},
    {deepCell:null},{deepScope:null},{subject:{...f.preparation.value.cell.subject,planQuestionId:'q-market'}}]){
    await assert.rejects(researchCall(intent.value.role,intent.value.dispatch,intent.value.cursor.instruction,{...context,...change},undefined,
      {store:f.store,draftId:intent.value.draft.id,questionId:intent.value.question.id,purpose:'analyst',consumerIntent:reference(intent)}),e=>e instanceof EngineError);
    assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
  }
  const capacity={...intent.value.cursor.resultCapacity,bindings:{...intent.value.cursor.resultCapacity.bindings}};
  delete capacity.bindings.deepPreparation;
  assert.throws(()=>prepareResearchEnvelope(intent.value.role,intent.value.dispatch,intent.value.cursor.instruction,context,
    {store:f.store,draftId:intent.value.draft.id,questionId:intent.value.question.id,purpose:'analyst'},capacity),e=>e instanceof EngineError);
  assert.equal(all(f.store),before);
});

test('5.3 deep requires a managed intent while ordinary broad analyst work preserves its own era and state',async t=>{
  const f=await ready(t),intent=prepareDeepResearch(f.store,f.input),context=consumerIntentContext(f.store,intent.value);
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length;
  await assert.rejects(researchCall(intent.value.role,intent.value.dispatch,intent.value.cursor.instruction,context,undefined,
    {store:f.store,draftId:intent.value.draft.id,questionId:intent.value.question.id,purpose:'analyst'}),e=>e instanceof EngineError);
  assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
  const broad=f.prepare();await broad.invoke();
  const broadWire=f.wires().at(-1)!.subject;
  assert.equal(Object.hasOwn(broadWire,'deepPreparation'),false);assert.equal(Object.hasOwn(broadWire,'deepCell'),false);
  const deep=(await runDeepResearch(f.store,f.input))!;
  const broadCalls=f.store.list<any>('model-call').filter(r=>r.value.consumerIntent?.id===broad.intent.id);
  assert.equal(broadCalls.length,1);assert.notEqual(broadCalls[0]!.id,deep.call.id);
  const states=f.store.list<any>('continuation-state');
  const own=states.find(r=>canonical(r.value.deepPreparation??null)===canonical(reference(f.preparation)));
  assert.ok(own&&states.some(r=>r.id!==own.id&&canonical(r.value.subject??null)===canonical(f.preparation.value.cell.subject)));
});

test('5.3 renamed physical actor cannot seed another managed preparation or send',async t=>{
  const f=await ready(t),result=(await runDeepResearch(f.store,f.input))!;
  f.store.write({id:result.call.id,kind:'model-call',expected:result.call.revision,value:{...result.call.value,
    requested:{...result.call.value.requested,actor:f.environment.value.reviewer.actor}}});
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length;
  for(const store of [f.store,new Store(f.store.path)]){
    try{assert.throws(()=>prepareDeepResearch(store,{...f.input,role:f.environment.value.reviewer}),e=>e instanceof EngineError);
      await assert.rejects(runDeepResearch(store,{...f.input,role:f.environment.value.reviewer}),e=>e instanceof EngineError);
      assert.equal(all(store),before);assert.deepEqual(money(store),accounting);assert.equal(f.wires().length,sent);}
    finally{if(store!==f.store)store.close();}
  }
});

test('5.3 paid early returns cannot drop deep fields or label a broad paid answer as deep',async t=>{
  const f=await ready(t),prepared=prepareDeepResearch(f.store,f.input),context=consumerIntentContext(f.store,prepared.value);
  const invoke=(intent:typeof prepared,body:Record<string,any>)=>researchCall(intent.value.role,intent.value.dispatch,
    intent.value.cursor.instruction,body,undefined,{store:f.store,draftId:intent.value.draft.id,
      questionId:intent.value.question.id,purpose:'analyst',consumerIntent:reference(intent)});
  await invoke(prepared,context);
  const running=f.store.get<typeof prepared.value>(prepared.id)!;
  assert.equal(running.value.state,'running');
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length;
  for(const field of ['deepPreparation','deepCell','deepScope']){
    const body={...context};delete body[field];
    await assert.rejects(invoke(running,body),e=>e instanceof EngineError&&e.code==='research_deep_subject_invalid');
    assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
  }
  const broad=f.prepare();await broad.invoke();
  const broadPaid=f.store.get<typeof prepared.value>(broad.intent.id)!;
  const afterBroad=all(f.store),accountAfter=money(f.store),wireAfter=f.wires().length;
  await assert.rejects(invoke(broadPaid,context),e=>e instanceof EngineError&&e.code==='research_deep_subject_invalid');
  assert.equal(all(f.store),afterBroad);assert.deepEqual(money(f.store),accountAfter);assert.equal(f.wires().length,wireAfter);
  assert.ok(await runDeepResearch(f.store,f.input,{restoreOnly:true,allowance:0}));
});
