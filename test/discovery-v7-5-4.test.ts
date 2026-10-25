import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store, type Revision } from '../src/storage/store.js';
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
import { runDeepResearch } from '../src/discovery/deep-research-execution.js';
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
import { deepInvocationProgress, deepIdentityCalls, callDeepPreparation } from '../src/discovery/invocation-progress.js';
import { replayDeepResponse } from '../src/discovery/response-replay.js';
const typed = (error: unknown) => error instanceof EngineError;
class Without extends Store {
  constructor(path: string, private lost: (id: string, revision?: number) => boolean) { super(path); }
  override get<T = Json>(id: string, revision?: number): Revision<T> | null {
    return this.lost(id, revision) ? null : super.get<T>(id, revision);
  }
}
for (const model of [false, true]) test(`5.4 real ${model?'model':'owner'} deep progress and free cold replay retain the original subject`, async t => {
  const f = await ready(t, model), result = (await runDeepResearch(f.store, f.input))!;
  const ref = reference(f.preparation), actor = result.intent.value.role.actor;
  assert.deepEqual(callDeepPreparation(f.store, result.call), ref);
  assert.deepEqual(deepIdentityCalls(f.store, ref, 'analyst', actor).map(r=>r.id), [result.call.id]);
  const progress = deepInvocationProgress(f.store, ref, 'analyst', actor);
  assert.ok(progress.guards.some(r=>r.id===result.call.id));
  const replay = replayDeepResponse(f.store, ref, 'analyst', actor)!;
  assert.deepEqual(replay.research, { action:'answer', question:'q-industry', value:end, citations:[] });
  assert.deepEqual(replay.request, result.request); assert.deepEqual(replay.response, result.response);
  assert.equal(replayDeepResponse(f.store, ref, 'analyst', 'other-actor'), null);
  assert.equal(replayDeepResponse(f.store, ref, 'reader', actor), null);
  assert.notEqual(deepInvocationProgress(f.store, ref, 'reader', actor).key, progress.key);
  modeOf(f.store, model?'questions':'bypass');
  const before = all(f.store), accounting=money(f.store), sent=f.wires().length, cold=new Store(f.store.path);
  t.after(()=>cold.close());
  assert.deepEqual(replayDeepResponse(cold, ref, 'analyst', actor), replay);
  assert.deepEqual(deepInvocationProgress(cold, ref, 'analyst', actor), progress);
  assert.equal(all(cold), before); assert.deepEqual(money(cold), accounting); assert.equal(f.wires().length,sent);
});

test('5.4 structural preparation never supplies progress or replay', async t => {
  const f=await ready(t), value={...f.preparation.value,scope:reference(f.set!)};
  const forged=f.store.write({id:'discovery-deep-preparation:forged',kind:'discovery-deep-preparation',expected:0,value});
  const before=all(f.store), accounting=money(f.store), sent=f.wires().length;
  for(const read of [deepInvocationProgress,replayDeepResponse]) assert.throws(()=>read(f.store,reference(forged),'analyst',f.environment.value.implementer.actor),typed);
  assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
});

for(const field of ['actor','project','purpose','null','missing-marker'] as const) test(`5.4 ${field} head masquerade refuses hot and cold without handing over the response`,async t=>{
  const f=await ready(t), result=(await runDeepResearch(f.store,f.input))!, ref=reference(f.preparation), actor=result.intent.value.role.actor;
  const value:any={...result.call.value};
  if(field==='actor') value.requested={...value.requested,actor:'other-actor'};
  if(field==='project') value.projectId='other-project';
  if(field==='purpose') value.purpose='reader';
  if(field==='null') value.deepPreparation=null;
  if(field==='missing-marker') delete value.deepPreparation;
  f.store.write({id:result.call.id,kind:'model-call',expected:result.call.revision,value});
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length,cold=new Store(f.store.path);t.after(()=>cold.close());
  for(const store of [f.store,cold]) for(const read of [deepInvocationProgress,replayDeepResponse]) {
    assert.throws(()=>read(store,ref,'analyst',actor),typed);
    if(field==='actor')assert.throws(()=>read(store,ref,'analyst','other-actor'),typed);
    if(field==='project')assert.throws(()=>read(store,ref,'reader',actor),typed);
  }
  assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
});

test('5.4 missing origin, intent, physical request, response or archive refuses the complete managed chain',async t=>{
  const f=await ready(t),result=(await runDeepResearch(f.store,f.input))!,ref=reference(f.preparation),actor=result.intent.value.role.actor;
  const before=all(f.store),accounting=money(f.store),sent=f.wires().length;
  for(const lost of [result.call.id,result.intent.id,result.request.id,result.response.id,result.archive.id]){
    const view=new Without(f.store.path,(id,revision)=>id===lost&&(lost!==result.call.id||revision===1));
    try{for(const read of [deepInvocationProgress,replayDeepResponse])assert.throws(()=>read(view,ref,'analyst',actor),typed,lost);}
    finally{view.close();}
  }
  assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
});

for(const field of ['request','response','consumerIntent'] as const)test(`5.4 substituted ${field} is refused by progress and replay`,async t=>{
  const f=await ready(t),result=(await runDeepResearch(f.store,f.input))!,ref=reference(f.preparation),actor=result.intent.value.role.actor;
  const origin:any=result.call.value;
  for(const changed of [undefined,{id:`${field}:foreign`,revision:1,hash:'0'.repeat(64)}]){
    const value={...origin,[field]:changed===undefined?undefined:field==='consumerIntent'?changed:{...origin[field],record:changed}};
    f.store.write({id:result.call.id,kind:'model-call',expected:f.store.get(result.call.id)!.revision,value:JSON.parse(JSON.stringify(value))});
    const before=all(f.store),accounting=money(f.store),sent=f.wires().length,cold=new Store(f.store.path);
    try{for(const store of [f.store,cold])for(const read of [deepInvocationProgress,replayDeepResponse])assert.throws(()=>read(store,ref,'analyst',actor),typed);}
    finally{cold.close();}
    assert.equal(all(f.store),before);assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
  }
});
