import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reference } from '../src/pipeline/contracts.js';
import { Store, type Revision } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { readVariantModelDecision } from '../src/discovery/variant-session.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantModelDecision, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantExecutionSession, type VariantSet } from '../src/discovery/discovery-variants.js';
import { ProjectModeSessions, issueProjectModeInvitation, VariantChoiceSessions, issueVariantChoiceInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { V7_STAGE_TOKEN_CEILING, V7_COMPLETION_RESERVE } from '../src/discovery/v7-contracts.js';
import { discoveryFixture, acceptPlan, planQuestion, validPlan, type PlanQuestion } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { publishVariantHandoff, readVariantHandoff, discoveryInspection } from '../src/discovery/discovery-outcome.js';
import { variantRecordId } from '../src/discovery/discovery-variants.js';
import { readVariantHandoffStructural, type VariantHandoff } from '../src/discovery/variant-decision.js';
import { publishVariantScope } from '../src/discovery/variant-scope.js';
import { EarlyStageDriver } from '../src/product/early-stage-driver.js';
import { EngineError } from '../src/errors.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const typedRefusal = (error: unknown) => error instanceof EngineError;
async function setup(t: test.TestContext, questions: PlanQuestion[] = [planQuestion('q-one', 'industry')], initialMode: 'questions'|'bypass'|null = 'questions') {
  const f = discoveryFixture(t, 'omg-4r2-');
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')), s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')), q=r.subject.question?.id??'probe';
let prior=[];try{prior=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line))}catch{}
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research=s.actions?.[prior.filter(row=>!row.subject.assessmentSubject&&!row.subject.variantSubject).length]??{action:'answer',question:q,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(research.question==='$selected')research.question=q;
if(r.subject.variantSubject?.kind==='decision')research=s.reject?{action:'reject_all',reason:'Model rejects this exact set'}:{action:'choose',key:'v1',reason:'Model chooses the bounded member'};
else if(r.subject.variantSubject){
 const grounds=[r.subject.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];
 research=s.none?{action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds}],searchLimits:['Saved sweep only'],unknowns:['Demand unknown']}
 :{action:'variants',variants:[{key:'v1',title:'Bounded variant',proposal:{bounded:true},criteria:Object.fromEntries(keys.map(key=>[key,{conclusion:'Bounded model proposal',grounds,assumptions:[],unknowns:['Demand unknown'],quantity:null}]))}],scale:Object.fromEntries(keys.map(key=>[key,'Same bounded scale'])),comparison:'One bounded option',recommendation:{key:'v1',reason:'Only bounded candidate'},searchLimits:['Saved sweep only'],unknowns:['Demand unknown']};
}
if(r.subject.role==='reader'){if(s.readerFail)process.exit(42);research={selections:r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]})),unresolved:[]}};
if(r.subject.assessmentSubject){
 const packet=r.subject.assessmentSubject.packet, attempts=packet.entries.map(entry=>({attempt:entry.attempt,reason:'Reviewed exact attempt'}));
 research={verdict:'return',reasons:['More material needed'],return:{target:{attempt:packet.entries[0].attempt},reason:'Continue research'},novelty:{attempts,accepted:[],rejected:[],newContent:[],duplicates:[],noProgress:attempts,transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):r.subject.variantSubject?.kind==='proposal'?(s.proposalTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, 'p', questions);
  function mode(value: 'questions'|'bypass') {
    const request = { project: 'p', mode: value, previous: f.store.get('project-mode:p') ? reference(f.store.get('project-mode:p')!) : null };
    const sessions = new ProjectModeSessions(f.store), invitation = issueProjectModeInvitation(f.store, request);
    assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
    const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
    const record = setProjectMode(f.store, request, sessions.authority(login.value.bearer)).record;
    assert.ok(sessions.revoke(login.value.bearer).ok); return record;
  }
  const initial = initialMode === null ? null : mode(initialMode);
  if (initial) {
    const cal = f.store.write({ id: 'variant-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
    for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
      { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? {snapshot: reference(cal)} : {set: reference(cal)}), mode: reference(initial), expectedSelection: null }, history: [] }, undefined,
      { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  }
  writeFileSync(wire, '');
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const generationCalls = () => wires().filter(row => row.subject.variantSubject);
  const nextEdition = () => {
    const plan = f.store.get<Question>(v.plan.id)!; f.discovery.reopen(plan.id, plan.revision);
    const question = f.store.get<Question>(plan.id)!, draft = f.store.get<DiscoveryDraft>(v.draft.id)!;
    const source = f.discovery.evidence.document('p', 'edition-two', 'New accepted edition', 'text/plain', 0);
    answerDiscoveryFixture(f.engine, 'p', draft, question, validPlan(v.frameRef, questions, 2, v.planAnswer), source);
    return f.store.get<Question>(plan.id)!.value.answer!;
  };
  return { ...f, v, environment, command, run, wires, generationCalls, configure, mode, initial, nextEdition };
}


const money = (store: Store) => store.list().filter(row => ['model-call', 'research-budget-ledger'].includes(row.kind)).flatMap(row => store.history(row.id));
function choiceScope(f: Awaited<ReturnType<typeof setup>>, kind: 'choose' | 'reject_all' = 'choose'): VariantChoiceScope {
  const set = f.store.list<VariantSet>('discovery-variant-set')[0]!, state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  return { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set),
    mode: reference(f.store.get('project-mode:p')!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: kind === 'choose' ? { kind, member: set.value.members[0]!, reason: 'Authorized owner chooses the member' }
      : { kind, reason: 'Authorized owner rejects the exact set' } };
}
function owner(store: Store, scope: VariantChoiceScope) {
  const sessions = new VariantChoiceSessions(store), issued = issueVariantChoiceInvitation(store, scope);
  assert.ok(issued.ok); if (!issued.ok) assert.fail('Expected successful owner exchange');
  const login = sessions.exchange({ projectId: 'p', invitation: issued.value.invitation });
  assert.ok(login.ok); if (!login.ok) assert.fail('Expected successful owner exchange');
  const act = answerVariantChoice(store, scope, sessions.authority(login.value.bearer));
  assert.ok(sessions.revoke(login.value.bearer).ok); return act;
}
const subjectCalls = (f: Awaited<ReturnType<typeof setup>>, kind: string) => f.wires().filter(w => w.subject.variantSubject?.kind === kind);
async function fixed(f: Awaited<ReturnType<typeof setup>>, result: Revision<import('../src/discovery/research-model.js').ResearchRun>) {
  const before = history(f.store), sent = f.wires();
  assert.deepEqual(await f.run(1, f.open(), true), result); assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), sent);
}

async function saved(f: Awaited<ReturnType<typeof setup>>, run: Revision<import('../src/discovery/research-model.js').ResearchRun>) {
  const pause = JSON.parse(run.value.error!);
  assert.ok(pause.handoff, JSON.stringify(run.value));
  const proof = await readVariantHandoff(f.store, 'p', pause.handoff);
  assert.equal(proof.verification, 'proven'); assert.equal(proof.record.value.next, pause.next);
  assert.deepEqual(reference(proof.record), pause.handoff); return proof.record;
}
for (const kind of ['choose', 'reject_all'] as const) test(`4R.2: public model ${kind} persists exact immutable route and free cold fixed point`, async t => {
  const f = await setup(t, undefined, 'bypass'); f.configure({ reject: kind === 'reject_all' });
  const run = await f.run(3), handoff = await saved(f, run), v = handoff.value;
  assert.equal(v.reason, kind); assert.equal(v.next, kind === 'choose' ? 'deep' : 'dossier');
  assert.equal(v.stop, null); assert.ok(v.snapshot && v.result && v.set && v.decision);
  assert.deepEqual(v.result, v.set); assert.deepEqual(v.plan, f.v.planAnswer); assert.deepEqual(v.frame, f.v.frameRef);
  assert.equal(Boolean(v.scope && v.choice), kind === 'choose');
  assert.equal(subjectCalls(f, 'proposal').length, 1); assert.equal(subjectCalls(f, 'decision').length, 1);
  assert.equal(discoveryInspection(f.store, f.store.get<DiscoveryDraft>(f.v.draft.id)!).outcome.state, 'researching');
  const before = history(f.store), wires = f.wires();
  assert.deepEqual((await publishVariantHandoff(f.open(), 'p', { draft: v.draft, result: v.result, decision: v.decision, scope: v.scope })).record, handoff);
  assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), wires); await fixed(f, run);
});
for (const kind of ['choose', 'reject_all'] as const) test(`4R.2: owner ${kind} after the questions door routes without a model send`, async t => {
  const f = await setup(t); const door = await f.run(3);
  assert.equal(door.value.pauseCode, 'research_variant_owner_required'); assert.equal(f.store.list('discovery-variant-handoff').length, 0);
  const act = owner(f.store, choiceScope(f, kind)), paid = money(f.store), wire = f.wires();
  const run = await f.run(1, f.open(), true), handoff = await saved(f, run);
  assert.equal(handoff.value.reason, kind); assert.deepEqual(handoff.value.decision, reference(act.decision));
  assert.equal(subjectCalls(f, 'decision').length, 0); assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  const clock = Date.now; const before = history(f.store);
  try { Date.now = () => clock() + 7 * 86400000; assert.deepEqual((await readVariantHandoff(f.open(), 'p', reference(handoff))).record, handoff); } finally { Date.now = clock; }
  assert.deepEqual(history(f.store), before); await fixed(f, run);
});
test('4R.2: actual paid no_variants routes to dossier with no invented set, choice or scope', async t => {
  const f = await setup(t, undefined, 'bypass'); f.configure({ none: true });
  const run = await f.run(3), handoff = await saved(f, run), v = handoff.value;
  assert.equal(v.reason, 'no_variants'); assert.equal(v.next, 'dossier'); assert.ok(v.snapshot && v.result);
  for (const key of ['set', 'decision', 'scope', 'choice', 'stop'] as const) assert.equal(v[key], null);
  assert.equal(subjectCalls(f, 'decision').length, 0); await fixed(f, run);
});
test('4R.2: real paid generation exhausts the stage budget and routes its materials without buying choice', async t => {
  const f = await setup(t, undefined, 'bypass');
  f.configure({ proposalTokens: V7_STAGE_TOKEN_CEILING - V7_COMPLETION_RESERVE });
  const run = await f.run(3), handoff = await saved(f, run), v = handoff.value;
  assert.equal(v.reason, 'early_limit'); assert.equal(v.next, 'dossier'); assert.ok(v.snapshot && v.set && v.result);
  assert.equal(v.decision, null); assert.equal(v.choice, null); assert.equal(v.scope, null);
  assert.equal(v.stop?.code, 'research_budget_exhausted'); assert.ok(v.stop!.grounds.length >= 3);
  assert.equal(subjectCalls(f, 'proposal').length, 1); assert.equal(subjectCalls(f, 'decision').length, 0);
  const proof = await readVariantHandoff(f.open(), 'p', reference(handoff)); f.mode('questions');
  assert.deepEqual(await readVariantHandoff(f.open(), 'p', reference(handoff)), proof); await fixed(f, await f.run(1, f.open(), true));
});
test('4R.2: per-invocation allowance and restoreOnly do not prove a subject early_limit', async t => {
  const f = await setup(t, undefined, 'bypass');
  const first = await f.run(1); assert.equal(first.value.pauseCode, 'research_turns_exhausted');
  assert.equal(f.store.list('discovery-variant-handoff').length, 0);
  await f.run(1, f.open(), true); assert.equal(f.store.list('discovery-variant-handoff').length, 0);
  const before = history(f.store), wires = f.wires();
  await assert.rejects(() => publishVariantHandoff(f.store, 'p', { draft: reference(f.store.get<DiscoveryDraft>(f.v.draft.id)!), result: null, decision: null, scope: null, earlyLimit: true }), { code: 'discovery_variant_handoff_invalid' });
  assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), wires);
});
test('4R.2: crash after durable handoff before its normal pause recovers the same address without payment', async t => {
  const f = await setup(t, undefined, 'bypass'), write = f.store.writeMany.bind(f.store); let hit = false;
  f.store.writeMany = ((ws, guards) => {
    const rows = write(ws, guards);
    if (!hit && rows.some(row => row.kind === 'discovery-variant-handoff')) { hit = true; throw new Error('cut after durable handoff'); }
    return rows;
  }) as typeof f.store.writeMany;
  const cut = await f.run(3); assert.equal(cut.value.pauseCode, 'research_interrupted'); assert.ok(hit);
  f.store.writeMany = write;
  const old = f.store.list<VariantHandoff>('discovery-variant-handoff')[0]!, paid = money(f.store), wires = f.wires();
  const restored = await f.run(1, f.open(), true), result = await saved(f, restored);
  assert.deepEqual(result, old); assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wires); await fixed(f, restored);
});
for (const shift of ['mode', 'owner', 'edition'] as const) test(`4R.2: second Store ${shift} race cannot publish an outdated handoff`, async t => {
  const f = await setup(t, undefined, 'bypass'), write = f.store.writeMany.bind(f.store); let hit = false;
  f.store.writeMany = ((ws, guards) => {
    if (!hit && ws.some(row => row.kind === 'discovery-variant-handoff')) {
      hit = true;
      if (shift === 'mode') {
        const second = f.open(), prior = second.get('project-mode:p')!, request = { project: 'p', mode: 'questions' as const, previous: reference(prior) };
        const sessions = new ProjectModeSessions(second), invitation = issueProjectModeInvitation(second, request); assert.ok(invitation.ok); if (!invitation.ok) assert.fail();
        const login = sessions.exchange({ project: 'p', invitation: invitation.value.invitation }); assert.ok(login.ok); if (!login.ok) assert.fail();
        setProjectMode(second, request, sessions.authority(login.value.bearer));
      } else if (shift === 'edition') f.nextEdition();
      else {
        const second = f.open(), set = second.list<VariantSet>('discovery-variant-set')[0]!, state = second.get<VariantState>(variantStateId('p', f.v.draft.id))!;
        owner(second, { ...choiceScope(f), mode: reference(second.get('project-mode:p')!), operation: 'override', previous: state.value.decision!, expectedSelection: reference(state), outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'Concurrent owner override' } });
      }
    }
    return write(ws, guards);
  }) as typeof f.store.writeMany;
  const refused = await f.run(3); f.store.writeMany = write;
  assert.ok(hit); assert.equal(f.store.list('discovery-variant-handoff').length, 0); assert.notEqual(refused.value.pauseCode, 'research_variant_handoff_unavailable');
  assert.equal(subjectCalls(f, 'proposal').length, 1); assert.equal(subjectCalls(f, 'decision').length, 1);
  const paid = money(f.store), wire = f.wires(); await f.run(1, f.open(), true); assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
});
test('4R.2: exact historical handoff survives owner override/revise, mode and plan shifts without reactivation', async t => {
  const f = await setup(t, undefined, 'bypass'), run = await f.run(3), record = await saved(f, run), original = await readVariantHandoff(f.store, 'p', reference(record));
  const state = f.store.get<VariantState>(variantStateId('p', f.v.draft.id))!;
  const override = owner(f.store, { ...choiceScope(f), operation: 'override', previous: state.value.decision!, expectedSelection: reference(state) });
  f.mode('questions');
  owner(f.store, { ...choiceScope(f, 'reject_all'), operation: 'revise', previous: reference(override.decision) });
  f.mode('bypass'); f.nextEdition();
  const before = history(f.store), paid = money(f.store), wire = f.wires();
  assert.deepEqual(await readVariantHandoff(f.open(), 'p', reference(record)), original);
  assert.deepEqual((await publishVariantHandoff(f.open(), 'p', { draft: record.value.draft, result: record.value.result, decision: record.value.decision, scope: record.value.scope })).record, record);
  assert.deepEqual(history(f.store), before); assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
});
test('4R.2: missing, foreign, incomplete and structural lookalike handoff bases refuse without side effects', async t => {
  const f = await setup(t, undefined, 'bypass'), run = await f.run(3), record = await saved(f, run), v = record.value;
  for (const key of Object.keys(v)) {
    const damaged = { ...v } as Record<string, unknown>; delete damaged[key];
    const fake = f.store.write({ id: `missing-${key}`, kind: 'discovery-variant-handoff', expected: 0, value: damaged });
    const before = history(f.store); await assert.rejects(() => readVariantHandoff(f.open(), 'p', reference(fake)), typedRefusal); assert.deepEqual(history(f.store), before);
  }
  for (const patch of [{ projectId: 'other' }, { decision: v.result }, { choice: v.plan }, { set: v.plan }, { plan: v.frame }, { reason: 'unknown' }, { scope: null }, { draft: { id: v.draft.id } }]) {
    const value = { ...v, ...patch }, id = variantRecordId('discovery-variant-handoff', value);
    const fake = f.store.write({ id, kind: 'discovery-variant-handoff', expected: 0, value });
    const before = history(f.store); await assert.rejects(() => readVariantHandoff(f.open(), 'p', reference(fake)), typedRefusal); assert.deepEqual(history(f.store), before);
  }
  const originalDecision = f.store.get<VariantModelDecision>(v.decision!.id, v.decision!.revision)!;
  const impostorValue = { ...originalDecision.value, outcome: { ...originalDecision.value.outcome, reason: 'Structurally consistent impersonation' } };
  const impostor = f.store.write({ id: variantRecordId('discovery-variant-model-decision', impostorValue), kind: 'discovery-variant-model-decision', expected: 0, value: impostorValue });
  const originalScope = f.store.get<import('../src/discovery/variant-decision.js').VariantScope>(v.scope!.id, v.scope!.revision)!;
  const scopeValue = { ...originalScope.value, decision: reference(impostor) };
  const scope = f.store.write({ id: variantRecordId('discovery-variant-scope', scopeValue), kind: 'discovery-variant-scope', expected: 0, value: scopeValue });
  const impostorHandoff = { ...v, decision: reference(impostor), scope: reference(scope) };
  const fake = f.store.write({ id: variantRecordId('discovery-variant-handoff', impostorHandoff), kind: 'discovery-variant-handoff', expected: 0, value: impostorHandoff });
  assert.equal(readVariantHandoffStructural(f.store, 'p', reference(fake)).verification, 'structural');
  const before = history(f.store); await assert.rejects(() => readVariantHandoff(f.store, 'p', reference(fake)), typedRefusal);
  await assert.rejects(() => publishVariantHandoff(f.store, 'p', null as never), { code: 'discovery_variant_handoff_invalid' });
  await assert.rejects(() => publishVariantHandoff(f.store, 'p', undefined as never), { code: 'discovery_variant_handoff_invalid' });
  await assert.rejects(() => readVariantHandoff(f.store, 'other', reference(record)), typedRefusal);
  await assert.rejects(() => readVariantHandoff(f.store, 'p', { id: record.id } as never), typedRefusal);
  for (const field of ['result', 'decision', 'scope', 'draft']) {
    const input = { draft: v.draft, result: v.result, decision: v.decision, scope: v.scope } as Record<string, unknown>; delete input[field];
    await assert.rejects(() => publishVariantHandoff(f.store, 'p', input as never), typedRefusal);
  }
  assert.deepEqual(history(f.store), before);
});
test('4R.2: early-stage driver returns the proven D5 address and remains researching', async t => {
  const f = await setup(t, undefined, 'bypass'), run = await f.run(3), handoff = await saved(f, run);
  const paid = money(f.store), wire = f.wires();
  const result = await new EarlyStageDriver(new ProductEngine(f.open())).run({ project: 'p', draftId: f.v.draft.id, maxTurns: 1, maxCalls: 1 });
  assert.equal(result.end, 'stage_paused', JSON.stringify(result)); assert.equal(result.stage, 'discovery'); assert.equal(result.om, null);
  assert.deepEqual(result.reason?.handoff, reference(handoff)); assert.equal(result.reason?.next, 'deep'); assert.equal(result.reason?.target, 'deep');
  assert.equal(result.stageResult?.discovery?.state, 'researching');
  assert.ok(result.stageResult?.findings.every(row => row.code !== 'run_stopped')); assert.equal(f.store.list('stage-artifact').length, 0);
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
});

test('4R.2: actual paid assessment limit before generation has no fabricated snapshot/set/decision', async t => {
  const f = await setup(t); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 1000 });
  const run = await f.run(2), handoff = await saved(f, run);
  assert.equal(handoff.value.reason, 'early_limit'); assert.equal(handoff.value.next, 'dossier');
  for (const field of ['snapshot', 'result', 'set', 'decision', 'scope', 'choice'] as const) assert.equal(handoff.value[field], null);
  assert.equal(f.store.list('discovery-variant-snapshot').length, 0); assert.equal(subjectCalls(f, 'proposal').length, 0);
  assert.ok(handoff.value.stop?.grounds.length); await fixed(f, run);
});
test('4R.2: paid stale model without application cannot supply a handoff, while the real owner route remains available', async t => {
  const f = await setup(t); await f.run(2); f.mode('bypass');
  const write = f.store.writeMany.bind(f.store); let hit = false;
  f.store.writeMany = ((ws, guards) => {
    if (!hit && ws.some(row => row.kind === 'discovery-variant-session' && row.expected === 1
      && (row.value as VariantExecutionSession).variantSubject.kind === 'decision')) { hit = true; throw new Error('cut before paid model application'); }
    return write(ws, guards);
  }) as typeof f.store.writeMany;
  await f.run(1); f.store.writeMany = write; assert.ok(hit); f.mode('questions');
  const act = owner(f.store, choiceScope(f)), ready = await f.run(1, f.open(), true), route = await saved(f, ready);
  const model = f.store.list<VariantModelDecision>('discovery-variant-model-decision')[0]!, proof = readVariantModelDecision(f.store, 'p', reference(model));
  assert.equal(proof.state, null); assert.deepEqual(route.value.decision, reference(act.decision));
  const before = history(f.store), wire = f.wires();
  await assert.rejects(() => publishVariantHandoff(f.store, 'p', { draft: model.value.draft, result: model.value.set, decision: reference(model), scope: route.value.scope }), typedRefusal);
  assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), wire); await fixed(f, ready);
});

test('4R.2: direct common producer proves the current mode before a new handoff, including cold entry', async t => {
  const f = await setup(t); await f.run(2);
  const act = owner(f.store, choiceScope(f)), scope = publishVariantScope(f.store, 'p', reference(act.decision)).scope;
  const mode = f.store.get<import('../src/product/project-mode.js').ProjectModeRecord>('project-mode:p')!;
  f.store.write({ id: mode.id, kind: mode.kind, expected: mode.revision, value: { ...mode.value, mode: 'bypass' } });
  const before = history(f.store), wire = f.wires();
  const request = { draft: act.decision.value.draft, result: act.decision.value.set, decision: reference(act.decision), scope: reference(scope) };
  for (const store of [f.store, f.open()]) await assert.rejects(() => publishVariantHandoff(store, 'p', request), { code: 'project_mode_invalid' });
  assert.equal(f.store.list('discovery-variant-handoff').length, 0); assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), wire);
});

test('4R.2: structural usage and a copied receipt cannot manufacture a stage early_limit', async t => {
  const f = await setup(t); await f.run(1);
  const ledger = f.store.list<{ assignments: { call: string }[] }>('research-budget-ledger')[0]!;
  const assignment = ledger.value.assignments[0]!, call = f.store.get<ModelCall>(assignment.call)!;
  assert.ok(call.value.consumerIntent || call.value.assessmentApplication);
  const fake = f.store.write({ id: 'structural-paid-limit', kind: 'model-call', expected: 0,
    value: { ...call.value, usage: { ...call.value.usage!, inputTokens: V7_STAGE_TOKEN_CEILING } } });
  f.store.write({ id: ledger.id, kind: ledger.kind, expected: ledger.revision,
    value: { ...ledger.value, assignments: [...ledger.value.assignments, { ...assignment, call: fake.id }] } });
  const before = history(f.store), wire = f.wires();
  const request = { draft: reference(f.store.get<DiscoveryDraft>(f.v.draft.id)!), result: null, decision: null, scope: null, earlyLimit: true };
  for (const store of [f.store, f.open()]) await assert.rejects(() => publishVariantHandoff(store, 'p', request), typedRefusal);
  assert.equal(f.store.list('discovery-variant-handoff').length, 0); assert.deepEqual(history(f.store), before); assert.deepEqual(f.wires(), wire);
});

// Explicit negative corruption: remove only the live head, keeping every exact mode revision.
function loseModeHead(store: Store) {
  const sql = new DatabaseSync(store.path);
  try { sql.prepare('DELETE FROM heads WHERE entity_id=?').run('project-mode:p'); } finally { sql.close(); }
  assert.equal(store.get('project-mode:p'), null); assert.ok(store.history('project-mode:p').length);
}
const completeHistory = (store: Store) => ({ records: history(store), mode: store.history('project-mode:p'), money: money(store) });
for (const cold of [false, true]) test(`4R2-01: a new owner choose handoff refuses a lost current mode (${cold ? 'cold' : 'hot'})`, async t => {
  const f = await setup(t); await f.run(2);
  const act = owner(f.store, choiceScope(f)), scope = publishVariantScope(f.store, 'p', reference(act.decision)).scope;
  assert.equal(f.store.list('discovery-variant-handoff').length, 0); loseModeHead(f.store);
  const store = cold ? f.open() : f.store, before = completeHistory(store), wire = f.wires();
  await assert.rejects(() => publishVariantHandoff(store, 'p', { draft: act.decision.value.draft, result: act.decision.value.set,
    decision: reference(act.decision), scope: reference(scope) }), { code: 'project_mode_unset' });
  assert.deepEqual(completeHistory(store), before); assert.deepEqual(f.wires(), wire);
  assert.equal(store.list('discovery-variant-handoff').length, 0);
});
test('4R2-01: a real pre-generation budget limit can precede the first project mode', async t => {
  const f = await setup(t, undefined, null); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 1000 });
  assert.equal(f.store.get('project-mode:p'), null); assert.deepEqual(f.store.history('project-mode:p'), []);
  const run = await f.run(2), handoff = await saved(f, run);
  assert.equal(handoff.value.reason, 'early_limit'); assert.equal(handoff.value.next, 'dossier');
  for (const field of ['snapshot', 'result', 'set', 'decision', 'scope', 'choice'] as const) assert.equal(handoff.value[field], null);
  assert.equal(subjectCalls(f, 'proposal').length, 0); assert.equal(subjectCalls(f, 'decision').length, 0);
  assert.deepEqual(f.store.history('project-mode:p'), []); await fixed(f, run);
});
test('4R2-01: pre-generation budget limit cannot mistake a lost historical mode for its first mode', async t => {
  const f = await setup(t); f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 1000 });
  const write = f.store.writeMany.bind(f.store); let cut = false;
  f.store.writeMany = ((ws, guards) => {
    if (ws.some(row => row.kind === 'discovery-variant-handoff')) { cut = true; throw new Error('cut before handoff'); }
    return write(ws, guards);
  }) as typeof f.store.writeMany;
  await f.run(2); f.store.writeMany = write; assert.ok(cut);
  assert.equal(f.store.list('discovery-variant-handoff').length, 0); loseModeHead(f.store);
  const before = completeHistory(f.store), wire = f.wires();
  for (const store of [f.store, f.open()]) await assert.rejects(() => publishVariantHandoff(store, 'p', {
    draft: reference(store.get<DiscoveryDraft>(f.v.draft.id)!), result: null, decision: null, scope: null, earlyLimit: true,
  }), { code: 'project_mode_unset' });
  assert.deepEqual(completeHistory(f.store), before); assert.deepEqual(f.wires(), wire);
});
test('4R2-01: historical owner handoff and its exact replay survive loss of the current mode', async t => {
  const f = await setup(t); await f.run(2); owner(f.store, choiceScope(f));
  const run = await f.run(1, f.open(), true), handoff = await saved(f, run), value = handoff.value;
  loseModeHead(f.store); const before = completeHistory(f.store), wire = f.wires();
  for (const store of [f.store, f.open()]) {
    assert.deepEqual((await readVariantHandoff(store, 'p', reference(handoff))).record, handoff);
    const replay = await publishVariantHandoff(store, 'p', { draft: value.draft, result: value.result, decision: value.decision, scope: value.scope });
    assert.equal(replay.repeated, true); assert.deepEqual(replay.record, handoff);
  }
  assert.deepEqual(completeHistory(f.store), before); assert.deepEqual(f.wires(), wire);
});
