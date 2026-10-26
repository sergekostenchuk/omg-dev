import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashJson } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store, type Revision, type Write } from '../src/storage/store.js';
import { Discovery, type DiscoveryDraft } from '../src/discovery/discovery.js';
import { ProductEngine } from '../src/product/engine.js';
import { Researcher } from '../src/discovery/research-runner.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { V7_STAGE_TOKEN_CEILING, V7_COMPLETION_RESERVE, createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import { STAGE_BUDGET_ACTION, STAGE_BUDGET_INCREASE_KIND, STAGE_BUDGET_INCREASE_CONTRACT, ensureStageBudget,
  readEffectiveStageBudget, readStageBudgetIncrease, stageBudgetIncreaseId, stageBudgetPlan, stageBudgetSegmentId,
  type StageBudgetIncrease, type StageBudgetScope } from '../src/discovery/stage-token-budget.js';
import { budgetUsage, reserveResearchCall, type BudgetSegment } from '../src/runtime/research-budget.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import { DiscoveryChoiceAuthority, OwnerAuthority, ProjectModeAuthority, ProjectModeSessions, StageBudgetAuthority,
  StageBudgetSessions, VariantChoiceAuthority, VariantChoiceSessions, increaseStageBudget, issueProjectModeInvitation,
  issueStageBudgetInvitation, issueVariantChoiceInvitation, requireStageBudgetAuthority } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { VARIANT_OWNER_ACTION, variantStateId, type VariantChoiceScope, type VariantState } from '../src/discovery/variant-decision.js';
import { VARIANT_SUBJECT_CONTRACT, type VariantSet } from '../src/discovery/discovery-variants.js';
import { answerVariantChoice } from '../src/discovery/discovery-decision.js';
import { readDeepFrontierStop } from '../src/discovery/discovery-outcome.js';
import { produceStoppedPartialDossier, readPartialDossier } from '../src/discovery/dossier-manifest.js';
import { referenceSites } from '../src/storage/reference-sites.js';
import { checkStoreIntegrity } from '../src/storage/fsck.js';
import type { OmResult } from '../src/om/refusal.js';
import { discoveryFixture, acceptPlan, planQuestion, type PlanQuestion } from './discovery-v7-fixture.js';

function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.refusal.code}: ${result.refusal.message}`);
  return (result as { ok: true; value: T }).value;
}
function no<T>(result: OmResult<T>, code: string) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.refusal.code, code, result.refusal.message);
}
const history = (store: Store) => store.list().flatMap(row => store.history(row.id));
const money = (store: Store) => store.list().filter(row => ['model-call', 'research-budget-ledger', 'research-limit'].includes(row.kind))
  .flatMap(row => store.history(row.id));
const RAISED = 25_000_000;

function mockCall(id: string): ModelCall {
  return { projectId: 'p', draftId: 'd-1', purpose: 'analyst', requestId: id, startedAt: 1, finishedAt: null, status: 'running',
    requested: { actor: 'reader', model: 'fixture', effort: 'high', speed: 'fast', command: { executable: process.execPath, args: [] } },
    confirmed: { model: null, effort: null, speed: null }, request: { chars: 1, bytes: 1, hash: hashJson(id) },
    response: null, usage: null, usageSource: 'unavailable', error: null };
}
function reserve(store: Store, segment: Revision<BudgetSegment>, call: string, group: string, tokens: number) {
  const estimate = { kind: 'estimated' as const, tokens, basis: [reference(segment)], explanation: `Reserve of ${call}` };
  const planned = reserveResearchCall(store, { saved: segment }, call, [group], estimate, 'research');
  store.writeMany([{ id: call, kind: 'model-call', expected: 0, value: mockCall(call) }, ...planned.writes], planned.guards);
}
async function unit(t: test.TestContext) {
  const f = discoveryFixture(t, 'omg-sbi-');
  await f.engine.execute({ type: 'create-project', project: 'p', title: 'Stage budget increase' });
  const draft = createPartialV7Draft(f.discovery, 'p', 'concept');
  const segment = ensureStageBudget(f.store, draft);
  return { ...f, draft, segment };
}
function scopeOf(segment: Revision<BudgetSegment>, limit = RAISED, project = 'p'): StageBudgetScope {
  return { project, stage: 'discovery', previous: reference(segment), limit };
}
function login(store: Store, scope: StageBudgetScope, sessions = new StageBudgetSessions(store)) {
  const issued = ok(issueStageBudgetInvitation(store, scope));
  const opened = ok(sessions.exchange({ project: scope.project, invitation: issued.invitation }));
  return { sessions, issued, opened, authority: sessions.authority(opened.bearer)! };
}
/** Real exhaustion of the trusted 20M: 17M already reserved in one group; 2M more in another exceeds 20M − 2M reserve. */
function exhaust(f: Awaited<ReturnType<typeof unit>>) {
  reserve(f.store, f.segment, 'call-a', 'group-a', 17_000_000);
  const segment = stageBudgetPlan(f.store, f.draft).segment as Revision<BudgetSegment>;
  assert.throws(() => reserve(f.store, segment, 'call-b', 'group-b', 2_000_000), { code: 'budget_segment_exhausted' });
}

test('SBI: real exhaustion, owner grant and session raise only the stage limit; the existing reservation is admitted', async t => {
  const f = await unit(t);
  exhaust(f);
  const ledger = f.store.get(`research-budget-ledger:${hashJson(f.segment.id)}`)!, paidBefore = money(f.store);
  const scope = scopeOf(f.segment), owner = login(f.store, scope);
  const raised = increaseStageBudget(f.store, scope, owner.authority);
  assert.equal(raised.repeated, false);
  assert.equal(raised.segment.id, f.segment.id); assert.equal(raised.segment.revision, 2);
  assert.deepEqual(raised.segment.value, { ...f.segment.value, limit: RAISED });
  assert.equal(raised.segment.value.initialGroupLimit, V7_STAGE_TOKEN_CEILING);
  assert.equal(raised.segment.value.completionReserve, V7_COMPLETION_RESERVE);
  assert.equal(raised.increase.id, stageBudgetIncreaseId('p', 2)); assert.equal(raised.increase.revision, 1);
  assert.equal(raised.increase.kind, STAGE_BUDGET_INCREASE_KIND);
  assert.deepEqual(raised.increase.value, { contract: STAGE_BUDGET_INCREASE_CONTRACT, database: f.store.databaseId, project: 'p',
    stage: 'discovery', segment: reference(raised.segment), previous: reference(f.segment), limit: RAISED,
    authority: { session: reference(f.store.history(owner.opened.session.id).find(row => row.revision === owner.opened.session.revision)!), scope },
    at: raised.increase.value.at });
  // Accounting is untouched: same ledger revision, same calls, no working limit, no model send.
  assert.deepEqual(money(f.store), paidBefore);
  assert.deepEqual(reference(f.store.get(ledger.id)!), reference(ledger));
  // The common reader and every consumer of the plan see the proven raised limit.
  ok(owner.sessions.revoke(owner.opened.bearer));
  for (const store of [f.store, f.open()]) {
    const effective = readEffectiveStageBudget(store, 'p');
    assert.equal(effective.limit, RAISED); assert.deepEqual(effective.increases, [reference(raised.increase)]);
    assert.deepEqual(reference(readStageBudgetIncrease(store, 'p', reference(raised.increase))), reference(raised.increase));
    assert.deepEqual(reference(stageBudgetPlan(store, f.draft).segment as Revision<BudgetSegment>), reference(raised.segment));
  }
  const head = stageBudgetPlan(f.store, f.draft).segment as Revision<BudgetSegment>;
  reserve(f.store, head, 'call-b', 'group-b', 2_000_000);
  const usage = budgetUsage(f.store, head);
  assert.equal(usage.reserved, 19_000_000); assert.equal(usage.remaining, RAISED - 19_000_000);
  assert.deepEqual(usage.ledger!.value.assignments.map(row => row.call), ['call-a', 'call-b']);
  assert.equal(checkStoreIntegrity(f.store).findings.length, 0);
});

test('SBI: without an increase the exhausted stage stays refused; a stale or non-raising grant is not issued', async t => {
  const f = await unit(t);
  exhaust(f);
  const before = history(f.store);
  for (const request of [null, undefined, {}, { ...scopeOf(f.segment), stage: 'concept' }, { ...scopeOf(f.segment), extra: true },
    { ...scopeOf(f.segment), limit: 1.5 }, { ...scopeOf(f.segment), limit: -1 }, { ...scopeOf(f.segment), limit: Number.MAX_SAFE_INTEGER + 2 },
    { ...scopeOf(f.segment), previous: { id: 'research-budget:other', revision: 1, hash: f.segment.hash } },
    { ...scopeOf(f.segment), previous: f.segment.id }, { project: 'p', stage: 'discovery', limit: RAISED }])
    no(issueStageBudgetInvitation(f.store, request), 'owner_invitation_invalid');
  no(issueStageBudgetInvitation(f.store, scopeOf(f.segment, V7_STAGE_TOKEN_CEILING)), 'discovery_budget_increase_invalid');
  no(issueStageBudgetInvitation(f.store, { ...scopeOf(f.segment), previous: { ...reference(f.segment), revision: 2 } }), 'discovery_budget_increase_stale');
  no(issueStageBudgetInvitation(f.store, scopeOf(f.segment, RAISED, 'absent')), 'owner_invitation_invalid');
  assert.deepEqual(history(f.store), before);
  const segment = stageBudgetPlan(f.store, f.draft).segment as Revision<BudgetSegment>;
  assert.throws(() => reserve(f.store, segment, 'call-b', 'group-b', 2_000_000), { code: 'budget_segment_exhausted' });
  assert.equal(readEffectiveStageBudget(f.store, 'p').limit, V7_STAGE_TOKEN_CEILING);
});

test('SBI: actor strings, owner flags, forged instances and every other owner authority cannot raise', async t => {
  const f = await unit(t), scope = scopeOf(f.segment), before = history(f.store);
  const fake = Object.create(StageBudgetAuthority.prototype);
  fake.exercise = () => ({ ok: true, value: { session: reference(f.segment), at: Date.now() } });
  for (const candidate of [undefined, null, 'owner', 'local-owner', { owner: true }, { actor: 'owner' }, { mode: 'bypass' },
    reference(f.segment), 'f'.repeat(64), fake, { exercise: fake.exercise }]) {
    assert.throws(() => increaseStageBudget(f.store, scope, candidate), { code: 'owner_authority_invalid' });
    no(requireStageBudgetAuthority(candidate, { store: f.store, action: STAGE_BUDGET_ACTION, scope }), 'owner_authority_invalid');
  }
  for (const other of [OwnerAuthority, DiscoveryChoiceAuthority, ProjectModeAuthority, VariantChoiceAuthority])
    assert.throws(() => increaseStageBudget(f.store, scope, Object.create(other.prototype)), { code: 'owner_authority_foreign' });
  assert.throws(() => new StageBudgetAuthority(Symbol(), new StageBudgetSessions(f.store), f.store, 'x', 'y', scope),
    { code: 'owner_authority_invalid' });
  // A real authority of another owner action — the project mode — is refused by its class, not by its session.
  const modeRequest = { project: 'p', mode: 'questions' as const, previous: null };
  const modeSessions = new ProjectModeSessions(f.store), modeInvite = ok(issueProjectModeInvitation(f.store, modeRequest));
  const modeLogin = ok(modeSessions.exchange({ project: 'p', invitation: modeInvite.invitation }));
  const modeAuthority = modeSessions.authority(modeLogin.bearer);
  const modeRecord = setProjectMode(f.store, modeRequest, modeAuthority).record;
  const afterMode = history(f.store);
  assert.throws(() => increaseStageBudget(f.store, scope, modeAuthority), { code: 'owner_authority_foreign' });
  // A stage-budget invitation cannot open a session of another owner action, nor theirs this one.
  const invite = ok(issueStageBudgetInvitation(f.store, scope)).invitation, afterInvite = history(f.store);
  no(new ProjectModeSessions(f.store).exchange({ project: 'p', invitation: invite }), 'owner_invitation_invalid');
  no(new VariantChoiceSessions(f.store).exchange({ projectId: 'p', invitation: invite }), 'owner_invitation_invalid');
  no(new StageBudgetSessions(f.store).exchange({ project: 'p', invitation: modeInvite.invitation }), 'owner_invitation_invalid');
  assert.deepEqual(history(f.store), afterInvite);
  assert.ok(modeRecord && afterMode.length > before.length);
  assert.equal(readEffectiveStageBudget(f.store, 'p').limit, V7_STAGE_TOKEN_CEILING);
});

test('SBI: the session is bound to one Store, database, project and exact raise; revoked and expired sessions refuse', async t => {
  const f = await unit(t), g = await unit(t);
  await f.engine.execute({ type: 'create-project', project: 'q', title: 'Neighbour' });
  const q = ensureStageBudget(f.store, createPartialV7Draft(f.discovery, 'q', 'concept'));
  const scope = scopeOf(f.segment), owner = login(f.store, scope), before = history(f.store);
  for (const [request, code] of [[{ ...scope, limit: RAISED + 1 }, 'owner_authority_foreign'], [scopeOf(q, RAISED, 'q'), 'owner_authority_foreign'],
    [{ ...scope, stage: 'concept' }, 'discovery_budget_increase_invalid'], [{ ...scope, previous: reference(q) }, 'discovery_budget_increase_invalid']] as const)
    assert.throws(() => increaseStageBudget(f.store, request, owner.authority), { code });
  // Another database: the same project and the same body of segment, but not this Store.
  assert.throws(() => increaseStageBudget(g.store, scopeOf(g.segment), owner.authority), { code: 'owner_authority_foreign' });
  assert.throws(() => increaseStageBudget(f.open(), scope, owner.authority), { code: 'owner_authority_foreign' });
  no(new StageBudgetSessions(g.store).exchange({ project: 'p', invitation: owner.issued.invitation }), 'owner_invitation_invalid');
  no(new StageBudgetSessions(f.store).exchange({ project: 'q', invitation: owner.issued.invitation }), 'owner_invitation_foreign');
  no(new StageBudgetSessions(f.store).exchange({ project: 'p', invitation: owner.issued.invitation }), 'owner_invitation_spent');
  assert.deepEqual(history(f.store), before);
  const later = login(f.store, scope), now = Date.now();
  t.mock.method(Date, 'now', () => now + 31 * 60_000);
  assert.throws(() => increaseStageBudget(f.store, scope, later.authority), { code: 'owner_session_expired' });
  t.mock.restoreAll();
  ok(owner.sessions.revoke(owner.opened.bearer));
  assert.equal(owner.sessions.authority(owner.opened.bearer), null);
  assert.throws(() => increaseStageBudget(f.store, scope, owner.authority), { code: 'owner_session_revoked' });
  assert.equal(f.store.get(stageBudgetSegmentId('p'))!.revision, 1);
  assert.equal(f.store.get(stageBudgetIncreaseId('p', 2)), null);
});

test('SBI: a raised head without its proven act is refused; a markerless equal revision keeps the old contract', async t => {
  const f = await unit(t), segId = stageBudgetSegmentId('p');
  // Old contract: an unmarked revision equal to the trusted policy (5.7 rewrites the head like this) stays readable.
  const same = f.store.write<BudgetSegment>({ id: segId, kind: 'research-budget', expected: 1, value: f.segment.value });
  assert.deepEqual(readEffectiveStageBudget(f.store, 'p'), { segment: same, limit: V7_STAGE_TOKEN_CEILING,
    completionReserve: V7_COMPLETION_RESERVE, increases: [] });
  const forgedValue = { ...f.segment.value, limit: RAISED };
  const raised = f.store.write<BudgetSegment>({ id: segId, kind: 'research-budget', expected: 2, value: forgedValue });
  for (const store of [f.store, f.open()]) {
    assert.throws(() => readEffectiveStageBudget(store, 'p'), { code: 'discovery_budget_policy_invalid' });
    assert.throws(() => stageBudgetPlan(store, f.draft), { code: 'discovery_budget_policy_invalid' });
  }
  // A forged act beside it: a session Ref that is not a saved stage-budget session, then a real session of another raise.
  const act = (session: Ref, scope: StageBudgetScope): StageBudgetIncrease => ({ contract: STAGE_BUDGET_INCREASE_CONTRACT,
    database: f.store.databaseId, project: 'p', stage: 'discovery', segment: reference(raised), previous: reference(same),
    limit: RAISED, authority: { session, scope }, at: Date.now() });
  const actId = stageBudgetIncreaseId('p', 3);
  const forged = f.store.write({ id: actId, kind: STAGE_BUDGET_INCREASE_KIND, expected: 0,
    value: act(reference(f.store.get('project:p')!), scopeOf(same)) });
  assert.throws(() => readEffectiveStageBudget(f.store, 'p'), { code: 'discovery_budget_policy_invalid' });
  assert.throws(() => readStageBudgetIncrease(f.store, 'p', reference(forged)), { code: 'discovery_budget_policy_invalid' });
});

test('SBI: an act copied from a real raise cannot prove another revision, limit or project', async t => {
  const f = await unit(t), scope = scopeOf(f.segment), owner = login(f.store, scope);
  const raised = increaseStageBudget(f.store, scope, owner.authority), segId = stageBudgetSegmentId('p');
  const forgedSegment = f.store.write<BudgetSegment>({ id: segId, kind: 'research-budget', expected: 2,
    value: { ...raised.segment.value, limit: 40_000_000 } });
  f.store.write({ id: stageBudgetIncreaseId('p', 3), kind: STAGE_BUDGET_INCREASE_KIND, expected: 0,
    value: { ...raised.increase.value, segment: reference(forgedSegment), previous: reference(raised.segment), limit: 40_000_000 } });
  for (const store of [f.store, f.open()]) {
    assert.throws(() => readEffectiveStageBudget(store, 'p'), { code: 'discovery_budget_policy_invalid' });
    assert.throws(() => stageBudgetPlan(store, f.draft), { code: 'discovery_budget_policy_invalid' });
    // The real act still proves its own revision; later heads are irrelevant to it.
    assert.deepEqual(reference(readStageBudgetIncrease(store, 'p', reference(raised.increase))), reference(raised.increase));
  }
  // The act of p is no act of another project's identical segment.
  await f.engine.execute({ type: 'create-project', project: 'q', title: 'Neighbour' });
  ensureStageBudget(f.store, createPartialV7Draft(f.discovery, 'q', 'concept'));
  assert.throws(() => readStageBudgetIncrease(f.store, 'q', reference(raised.increase)), { code: 'discovery_budget_increase_invalid' });
});

test('SBI: the same act repeats without a second raise; a chain of two owner raises is proven in order', async t => {
  const f = await unit(t), scope = scopeOf(f.segment), owner = login(f.store, scope);
  const first = increaseStageBudget(f.store, scope, owner.authority), after = history(f.store);
  for (let i = 0; i < 2; i++) {
    const again = increaseStageBudget(f.store, scope, owner.authority);
    assert.equal(again.repeated, true);
    assert.deepEqual(reference(again.segment), reference(first.segment)); assert.deepEqual(reference(again.increase), reference(first.increase));
  }
  assert.deepEqual(history(f.store), after);
  // The spent previous cannot be raised again by a fresh grant.
  no(issueStageBudgetInvitation(f.store, scope), 'discovery_budget_increase_stale');
  const next = scopeOf(first.segment, 30_000_000), second = increaseStageBudget(f.store, next, login(f.store, next).authority);
  assert.equal(second.segment.revision, 3); assert.equal(second.segment.value.limit, 30_000_000);
  for (const store of [f.store, f.open()]) {
    const effective = readEffectiveStageBudget(store, 'p');
    assert.equal(effective.limit, 30_000_000);
    assert.deepEqual(effective.increases, [reference(first.increase), reference(second.increase)]);
  }
  assert.throws(() => increaseStageBudget(f.store, scope, owner.authority), { code: 'discovery_budget_increase_stale' });
});

test('SBI: a second Store wins the race — the same raise is returned, a different one leaves no partial loser', async t => {
  for (const competing of [RAISED, 30_000_000]) {
    const f = await unit(t), scope = scopeOf(f.segment), mine = login(f.store, scope);
    const other = f.open(), theirs = login(other, scopeOf(f.segment, competing));
    const original = f.store.writeMany.bind(f.store);
    const box: { theirs?: ReturnType<typeof increaseStageBudget> } = {};
    f.store.writeMany = function <T>(writes: Write[], guards: Parameters<Store['writeMany']>[1] = []) {
      f.store.writeMany = original;
      box.theirs = increaseStageBudget(other, scopeOf(f.segment, competing), theirs.authority);
      return original<T>(writes, guards);
    };
    if (competing === RAISED) {
      const result = increaseStageBudget(f.store, scope, mine.authority);
      assert.equal(result.repeated, true);
      assert.deepEqual(reference(result.increase), reference(box.theirs!.increase));
    } else assert.throws(() => increaseStageBudget(f.store, scope, mine.authority), { code: 'discovery_budget_increase_stale' });
    assert.equal(f.store.get(stageBudgetSegmentId('p'))!.revision, 2);
    assert.equal(f.store.get<BudgetSegment>(stageBudgetSegmentId('p'))!.value.limit, competing);
    assert.equal(f.store.history(stageBudgetIncreaseId('p', 2)).length, 1);
    assert.equal(f.store.get(stageBudgetIncreaseId('p', 3)), null);
    assert.equal(readEffectiveStageBudget(f.open(), 'p').limit, competing);
  }
});

test('SBI: saved records are closed and om-fsck enumerates exactly their Refs', async t => {
  const f = await unit(t), scope = scopeOf(f.segment), owner = login(f.store, scope);
  const raised = increaseStageBudget(f.store, scope, owner.authority);
  const fields = (row: Revision<unknown>) => referenceSites(row.kind, row.value).map(site => site.field).sort();
  assert.deepEqual(fields(raised.increase), ['authority.scope.previous', 'authority.session', 'previous', 'segment']);
  assert.deepEqual(fields(f.store.get(owner.issued.grant.id)!), ['scope.previous']);
  assert.deepEqual(fields(f.store.get(owner.opened.session.id)!), ['grant', 'scope.previous']);
  assert.deepEqual(referenceSites(raised.increase.kind, raised.increase.value).find(site => site.field === 'segment')!.ref, reference(raised.segment));
  assert.equal(checkStoreIntegrity(f.store).findings.length, 0);
});

// ---- the real paid exhaustion of 5.7, its saved stop and paid proof stay exactly proven after the owner raise ----------
async function paidStage(t: test.TestContext) {
  const questions: PlanQuestion[] = [planQuestion('q-one', 'industry', 'blocking'), planQuestion('q-two', 'market')];
  const f = discoveryFixture(t, 'omg-sbi-57-');
  f.engine.execute({ type: 'create-project', project: 'p', title: 'Runner generation' });
  const settings = join(f.root, 'settings.json'), wire = join(f.root, 'wire.ndjson'), adapter = join(f.root, 'adapter.mjs');
  const configure = (patch: Record<string, unknown> = {}) => {
    let prior = {}; try { prior = JSON.parse(readFileSync(settings, 'utf8')); } catch {}
    writeFileSync(settings, JSON.stringify({ ...prior, ...patch }));
  };
  configure();
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')), s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')), q=r.subject.question?.id??'probe';
let prior=[];try{prior=readFileSync(${JSON.stringify(wire)},'utf8').trim().split('\\n').filter(Boolean)}catch{}
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research={action:'answer',question:q,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
if(r.subject.subject?.contract==='v7-plan-subject/v1'&&!r.subject.deepPreparation){
 const at=r.subject.subject,id=at.planQuestionId;
 research={action:'answer',question:id,value:{type:'submitted',contract:'discovery-claims/v7',value:{claims:[{id:'broad-'+prior.length,kind:'hypothesis',text:'Common sweep material',axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:at.planAnswer,planQuestionId:id}],scope:{variants:'common'},basis:{howToVerify:'Measure the common domain'}}]}},citations:[]};
}
if(r.subject.deepPreparation){
 const cell=r.subject.deepCell, id=cell.subject.planQuestionId;
 research={action:'answer',question:id,value:{type:'submitted',contract:'discovery-claims/v7',value:{claims:[{id:'deep-'+prior.length,kind:'hypothesis',text:'Exact variant material',axis:id==='q-one'?'industry':'market',planQuestions:[{planAnswer:cell.subject.planAnswer,planQuestionId:id}],scope:{variants:[cell.variant.member]},basis:{howToVerify:'Measure the exact chosen variant'}}]}},citations:[]};
}
if(r.subject.variantSubject?.kind==='decision')research={action:'choose',key:'v1',reason:'Model chooses the bounded member'};
else if(r.subject.variantSubject){
 const grounds=[r.subject.variantSubject.snapshot],keys=['value','user','payer','costAndTime','risk','mandateFit'];
 research={action:'variants',variants:[{key:'v1',title:'Bounded variant',proposal:{bounded:true},criteria:Object.fromEntries(keys.map(key=>[key,{conclusion:'Bounded model proposal',grounds,assumptions:[],unknowns:['Demand unknown'],quantity:null}]))}],scale:Object.fromEntries(keys.map(key=>[key,'Same bounded scale'])),comparison:'One bounded option',recommendation:{key:'v1',reason:'Only bounded candidate'},searchLimits:['Saved sweep only'],unknowns:['Demand unknown']};
}
if(r.subject.role==='reader')research={selections:r.subject.sources.map((source,sourceIndex)=>({sourceIndex,firstLine:source.lines[0][0],lastLine:source.lines.at(-1)[0]})),unresolved:[]};
if(r.subject.assessmentSubject){
 const entries=r.subject.assessmentSubject.packet.entries;
 const all=r.subject.value.attempts.flatMap(row=>row.end.type==='submitted'?row.end.value.claims.map((claim,index)=>({claim:{project:r.subject.assessmentSubject.packet.project,container:row.attempt,containerKind:'research-attempt',pointer:'/claims/'+index,claimId:claim.id}})):[]);
 const accepted=all.map(c=>({claim:c.claim,reason:'Supported exact hypothesis or addressed unknown'}));
 research={verdict:'supported',reasons:['Exact material classification'],return:null,novelty:{attempts:entries.map(e=>({attempt:e.attempt,reason:'Exact attempt'})),accepted,rejected:[],newContent:accepted,duplicates:[],noProgress:entries.filter(e=>!accepted.some(c=>c.claim.container.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No accepted addition'})),transition:accepted.length?{outcome:'closed',bases:accepted.map(c=>({claim:c.claim})),reason:'The exact criterion has enough supported material',sufficiency:{criterion:'Named basis answering '+r.subject.assessmentSubject.packet.planQuestionId,requiredDepth:'deep',reason:'Required depth is met',methodologyRequirements:[]}}:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v2',facts:[]}};
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:r.subject.assessmentSubject?(s.assessorTokens??10):10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = f.engine.environments.configure('p', { workspace: f.root,
    implementer: { actor: 'model-author', model: 'fixture', effort: 'high', command },
    reviewer: { actor: 'model-reviewer', model: 'fixture', effort: 'high', command }, fullCheck: command, timeoutMs: 10000 }, 0);
  const calibration = f.discovery.create('p', 'discovery', 'R0', 'concept', [{ field: 'probe', kind: 'fact', prompt: 'Calibrate', risk: 'unknown', schema: { type: 'object' } }], [], 6);
  for (const purpose of ['analyst', 'assessor', 'escalation-assessor', 'reading-planner', 'reader']) await researchCall(purpose === 'reader'
    ? { actor: 'reader', model: 'fixture', effort: 'high', speed: 'inherited', command } : ['assessor', 'escalation-assessor'].includes(purpose) ? environment.value.reviewer : environment.value.implementer,
    environment.value, 'Calibrate', {}, undefined, { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose });
  const v = acceptPlan(f, 'p', questions);
  const modeRequest = { project: 'p', mode: 'questions' as const, previous: null };
  const modeSessions = new ProjectModeSessions(f.store), modeInvite = ok(issueProjectModeInvitation(f.store, modeRequest));
  const modeLogin = ok(modeSessions.exchange({ project: 'p', invitation: modeInvite.invitation }));
  const mode = setProjectMode(f.store, modeRequest, modeSessions.authority(modeLogin.bearer)).record;
  ok(modeSessions.revoke(modeLogin.bearer));
  const cal = f.store.write({ id: 'variant-calibration', kind: 'transport-fixture', expected: 0, value: { projectId: 'p' } });
  for (const kind of ['proposal', 'decision'] as const) await researchCall(environment.value.implementer, environment.value, 'Calibrate variant step',
    { variantSubject: { contract: VARIANT_SUBJECT_CONTRACT, kind, ...(kind === 'proposal' ? { snapshot: reference(cal) } : { set: reference(cal) }), mode: reference(mode), expectedSelection: null }, history: [] }, undefined,
    { store: f.store, draftId: calibration.id, questionId: calibration.value.questions[0]!, purpose: `variant-${kind}` });
  writeFileSync(wire, '');
  const run = (limit = 8, store = f.store, restoreOnly = false) => new Researcher(store, new Discovery(store), new ProductEngine(store).environments)
    .run('p', v.draft.id, limit, undefined, { producerPolicy: { discovery: 7 }, restoreOnly });
  const wires = () => readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean);
  return { ...f, v, run, wires, configure };
}
function chooseFirst(store: Store, draft: Revision<DiscoveryDraft>) {
  const state = store.get<VariantState>(variantStateId('p', draft.id))!;
  const set = store.get<VariantSet>(state.value.set!.id, state.value.set!.revision)!;
  const scope: VariantChoiceScope = { action: VARIANT_OWNER_ACTION, projectId: 'p', draft: set.value.draft, set: reference(set),
    mode: reference(store.get('project-mode:p')!), operation: 'initial', previous: null, expectedSelection: reference(state),
    outcome: { kind: 'choose', member: set.value.members[0]!, reason: 'Authorized owner chooses the member' } };
  const sessions = new VariantChoiceSessions(store), issued = ok(issueVariantChoiceInvitation(store, scope));
  const opened = ok(sessions.exchange({ projectId: 'p', invitation: issued.invitation }));
  answerVariantChoice(store, scope, sessions.authority(opened.bearer));
  ok(sessions.revoke(opened.bearer));
}

test('SBI: after the owner raise the saved paid budget stop, its partial dossier and paid accounting stay exactly proven', async t => {
  const f = await paidStage(t);
  const generated = await f.run(3);
  assert.equal(generated.value.pauseCode, 'research_variant_owner_required', generated.value.error!);
  chooseFirst(f.store, f.v.draft);
  const pending = await f.run(1, f.store, true);
  assert.equal(pending.value.pauseCode, 'research_deep_frontier_pending', pending.value.error!);
  f.configure({ assessorTokens: V7_STAGE_TOKEN_CEILING - 2_000_000 });
  const stopped = await f.run(2), details = JSON.parse(stopped.value.error!);
  assert.equal(stopped.value.pauseCode, 'research_dossier_assessment_unavailable', stopped.value.error!);
  const stop = await readDeepFrontierStop(f.store, 'p', details.stop), dossier = await readPartialDossier(f.store, 'p', details.dossier);
  assert.equal(stop.record.value.reason, 'budget');
  const effective = readEffectiveStageBudget(f.store, 'p'), paid = money(f.store), wire = f.wires();
  assert.equal(effective.limit, V7_STAGE_TOKEN_CEILING);
  const scope = scopeOf(effective.segment!, V7_STAGE_TOKEN_CEILING + 10_000_000), owner = login(f.store, scope);
  const raised = increaseStageBudget(f.store, scope, owner.authority);
  ok(owner.sessions.revoke(owner.opened.bearer));
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
  for (const store of [f.store, f.open()]) {
    assert.equal(readEffectiveStageBudget(store, 'p').limit, V7_STAGE_TOKEN_CEILING + 10_000_000);
    assert.deepEqual((await readDeepFrontierStop(store, 'p', details.stop)).record, stop.record);
    assert.deepEqual((await readPartialDossier(store, 'p', details.dossier)).record, dossier.record);
    assert.equal((await produceStoppedPartialDossier(store, 'p', details.stop)).repeated, true);
    assert.deepEqual(reference(readStageBudgetIncrease(store, 'p', reference(raised.increase))), reference(raised.increase));
  }
  assert.deepEqual(money(f.store), paid); assert.deepEqual(f.wires(), wire);
});
