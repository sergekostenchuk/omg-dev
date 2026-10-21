import { estimateCliCall } from "../src/adapters/codex-estimate.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Revision } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { budgetSegment, reserveResearchCall, prepareNewSegmentReservation, segmentCompletionReserve, budgetUsage, raiseWorkingLimit, workingLimit, assertQuestionBudget, budgetGroups, segmentId, type BudgetSegment, type NewBudgetSegment, type BudgetSegmentTarget, type Optimization } from '../src/runtime/research-budget.js';
import { assertPilotBoundary } from '../src/discovery/reader-pilot.js';
import { configurePhasePolicy } from '../src/discovery/phase-policy.js';
import { scopeObligations, type ResearchScope } from '../src/graph/research-scope.js';
import type { ModelCall } from '../src/runtime/model-usage.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(),'omg-budget-'));
  const store = new Store(join(root,'state.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const basis = store.write({id:'basis',kind:'source',expected:0,value:{proof:'fixture'}});
  return {store,basis,root};
}
const role = {actor:'a',model:'fixture',effort:'high' as const,command:{executable:process.execPath,args:[]}};
function call(id: string): ModelCall { return {projectId:'p',draftId:'d',purpose:'analyst',requestId:id,startedAt:1,finishedAt:null,status:'running',requested:role,
  confirmed:{model:null,effort:null,speed:null},request:{chars:1000,bytes:1000,hash:hashJson(id)},response:null,usage:null,usageSource:'unavailable',error:null}; }
/** Seed an existing segment through the current producer: one atomic batch of
 * segment + ledger + model-call. The seed reservation is real accounted spend. */
function seedSegment(store: Store, basis: Revision<unknown>, key: string, limit: number, initialGroupLimit: number, completionReserve: number, ownerGroupCeiling?: number) {
  const creating: NewBudgetSegment = { projectId:'p', key, limit, initialGroupLimit, completionReserve,
    ...(ownerGroupCeiling === undefined ? {} : { ownerGroupCeiling }) };
  const seed = prepareNewSegmentReservation(store, creating, `seed-${key}`, ['seed'],
    { kind:'estimated', tokens: Math.min(100, initialGroupLimit), basis:[reference(basis)], explanation:'seed reservation' });
  store.writeMany([{ id:`seed-${key}`, kind:'model-call', expected:0, value:call(`seed-${key}`) }, ...seed.writes], seed.guards);
  return budgetSegment(store, 'p', key);
}

test('reservations cannot share the remaining budget; unknown usage holds the original reserve',t=>{
  const {store,basis}=fixture(t);
  const estimate={kind:'estimated' as const,tokens:600,basis:[reference(basis)],explanation:'fixture estimate'};
  const left=prepareNewSegmentReservation(store,{projectId:'p',key:'R2-L3',limit:1000,initialGroupLimit:700,completionReserve:0},'c1',['g1'],estimate);
  store.writeMany([{id:'c1',kind:'model-call',expected:0,value:call('c1')},...left.writes],left.guards);
  const segment=budgetSegment(store,'p','R2-L3');
  assert.throws(()=>reserveResearchCall(store,{saved:segment},'c2',['g2'],estimate),{code:'budget_segment_exhausted'});
  assert.equal(store.get('c2'),null);
  const current=store.get<ModelCall>('c1')!;
  store.write({id:'c1',kind:'model-call',expected:current.revision,value:{...current.value,status:'failed',finishedAt:2}});
  assert.equal(budgetUsage(store,segment).reserved,600);
  assert.throws(()=>reserveResearchCall(store,{saved:segment},'c3',['g2'],estimate),{code:'budget_segment_exhausted'});
  const failed=store.get<ModelCall>('c1')!;
  store.write({id:'c1',kind:'model-call',expected:failed.revision,value:{...failed.value,usage:{inputTokens:200,outputTokens:100,cachedInputTokens:150,reasoningOutputTokens:20}}});
  const usage=budgetUsage(store,segment);
  assert.equal(usage.measured,300); assert.equal(usage.reserved,0); assert.equal(usage.remaining,700);
});

test('working limit uses required need plus ten percent, rejects missing exceptions and repeated progress',t=>{
  const {store,basis}=fixture(t);
  const segment=seedSegment(store,basis,'large',10_000_000,700_000,0);
  const decision: Optimization={reason:'necessary remaining work',progress:'new-source',required:800000,obligations:['exception','external-consumer'],forecast:'measured plus remaining roles',basis:[reference(basis)],
    options:[{method:'exact-dedup',saved:100,decision:'accept',quality:'all original obligations retained',preserved:['exception','external-consumer']}]};
  const changed=raiseWorkingLimit(store,segment,'g','tokens',700000,decision,900000);
  assert.equal(changed.value.limit,880000);
});

test('foreign/missing estimates and loss of constraints are typed refusals',t=>{
  const {store,basis}=fixture(t);
  assert.throws(()=>reserveResearchCall(store,{creating:{projectId:'p',key:'estimates',limit:1000,initialGroupLimit:700,completionReserve:0}},'c',['g'],{kind:'estimated',tokens:0,basis:[],explanation:''}),{code:'budget_estimate_missing'});
  const segment=seedSegment(store,basis,'large',10_000_000,700_000,0);
  const decision: Optimization={reason:'need',progress:'p',required:800,obligations:['exception','consumer'],forecast:'required work',basis:[reference(basis)],
    options:[{method:'drop-consumer',saved:50,decision:'accept',quality:'claim only',preserved:['exception']}]};
  assert.throws(()=>raiseWorkingLimit(store,segment,'g','tokens',700,decision),{code:'budget_quality_loss'});
  decision.options[0]!.decision='reject';
  assert.equal(raiseWorkingLimit(store,segment,'g','tokens',700,decision,1000).value.limit,880);
  assert.throws(()=>raiseWorkingLimit(store,segment,'g','tokens',700,{...decision,required:900},1000),{code:'budget_no_progress'});
  assert.equal(store.get(segment.id)!.revision,1);
});

test('budget group survives recreated questions, new ids and split target fields',t=>{
  const {store}=fixture(t);
  for(const [id,field] of [['q1','code'],['q2','tests']]) {
    store.write({id:`d-${id}`,kind:'discovery-draft',expected:0,value:{projectId:'p',questions:[id]}});
    store.write({id:id!,kind:'question',expected:0,value:{projectId:'p',draftId:`d-${id}`,spec:{field:`gap_${id}`,targets:[{target:'n-state',field,consumer:'c',question:'changed wording'}]}}});
  }
  assert.deepEqual(budgetGroups(store,'d-q1','q1'),budgetGroups(store,'d-q2','q2'));
  assert.throws(()=>budgetGroups(store,'d-q2','q1'),{code:'budget_question_missing'});
});

test('empirical CLI estimate uses comparable full usage, stays estimated and never assumes zero for missing evidence',t=>{
  const {store}=fixture(t);
  assert.throws(()=>estimateCliCall(store,'p',role,'analyst',2000),{code:'budget_estimate_missing'});
  store.write({id:'sample',kind:'model-call',expected:0,value:{...call('sample'),status:'succeeded',finishedAt:2,usage:{inputTokens:200,outputTokens:100,cachedInputTokens:150,reasoningOutputTokens:40}}});
  const estimate=estimateCliCall(store,'p',role,'analyst',2000);
  assert.equal(estimate.kind,'estimated');assert.equal(estimate.tokens,660);
});

test('UI deferral wakes on UI requirement, changed QuestionPanel or added UI boundary without fake anchors',()=>{
  const scope={nodes:['n-state'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
    obligations:[{gap:{id:'actors-g5',target:'n-ui',consumer:'n-ui'},state:'deferred',reason:'owner deferred',wake:{nodes:['n-ui'],paths:['ui/app.tsx'],uiRequired:true}}]} as unknown as ResearchScope;
  assert.equal(scopeObligations(scope)[0]!.state,'deferred');
  for(const changed of [{uiRequired:true},{changedPaths:['ui/app.tsx']},{boundaries:[{node:'n-ui',reason:'new consumer'}]}])
    assert.equal(scopeObligations({...scope,...changed})[0]!.state,'active');
  assert.equal(scope.obligations[0]!.state,'deferred');
});

test('old pilot remains bounded at L2; disabling protection cannot bypass explicit L3 continuation',t=>{
  const {store}=fixture(t);
  store.write({id:'reader-pilot:p',kind:'reader-pilot',expected:0,value:{projectId:'p',experimental:true,active:true,stopAfter:'L2',reader:{...role,actor:'reader',speed:'fast'},agentCommand:role.command,maxRequestChars:300000,maxReadChars:60000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:10000000}});
  assert.throws(()=>assertPilotBoundary(store,'p','R2'),{code:'pilot_boundary_reached'});
  const old=store.get<any>('reader-pilot:p')!;
  store.write({id:old.id,kind:old.kind,expected:old.revision,value:{...old.value,active:false}});
  assert.throws(()=>assertPilotBoundary(store,'p','R2'),{code:'pilot_boundary_reached'});
  store.write({id:old.id,kind:old.kind,expected:old.revision+1,value:old.value});
  configurePhasePolicy(store,'p','L3','R2-L3',0);
  assert.doesNotThrow(()=>assertPilotBoundary(store,'p','R2'));
  assert.doesNotThrow(()=>assertPilotBoundary(store,'p','L3'));
  assert.throws(()=>assertPilotBoundary(store,'p','R3'),{code:'pilot_boundary_reached'});
  assert.throws(()=>configurePhasePolicy(store,'p','L3','reset',1),{code:'budget_segment_changed'});
  const pilot=store.get<any>('reader-pilot:p')!;
  store.write({id:pilot.id,kind:pilot.kind,expected:pilot.revision,value:{...pilot.value,active:false}});
  assert.throws(()=>assertPilotBoundary(store,'p','R2'),{code:'phase_protections_missing'});
});

test('actual usage beyond the reserve remains visible and blocks future calls',t=>{
  const {store,basis}=fixture(t);
  const reservation=prepareNewSegmentReservation(store,{projectId:'p',key:'R2-L3',limit:1000,initialGroupLimit:700,completionReserve:0},'overflow',['g'],{kind:'estimated',tokens:100,basis:[reference(basis)],explanation:'uncertain'});
  store.writeMany([{id:'overflow',kind:'model-call',expected:0,value:{...call('overflow'),status:'succeeded',usage:{inputTokens:1000,outputTokens:200,cachedInputTokens:0,reasoningOutputTokens:0}}},...reservation.writes],reservation.guards);
  const segment=budgetSegment(store,'p','R2-L3');
  assert.equal(budgetUsage(store,segment).remaining,-200);
  assert.throws(()=>reserveResearchCall(store,{saved:segment},'next',['g'],{kind:'estimated',tokens:1,basis:[reference(basis)],explanation:'minimum'}),{code:'budget_segment_exhausted'});
});

test('declared physical capacity blocks working expansion before a provider call and groups retain metric history',t=>{
  const {store,basis}=fixture(t);
  const segment=seedSegment(store,basis,'R2-L3',1000,700,0);
  const decision:Optimization={reason:'measured mandatory size',progress:'one',required:80,obligations:['g'],forecast:'80 chars',basis:[reference(basis)],options:[{method:'exact dedup',saved:0,decision:'reject',quality:'No further safe reduction',preserved:[]}]};
  assert.throws(()=>raiseWorkingLimit(store,segment,'g','requestChars',70,decision),{code:'budget_ceiling_required'});
  assert.throws(()=>raiseWorkingLimit(store,segment,'g','requestChars',70,decision,85),{code:'budget_transport_limit'});
  assert.equal(raiseWorkingLimit(store,segment,'g','requestChars',70,decision,100).value.limit,88);
  assert.equal(workingLimit(store,segment,'g,new-target','requestChars',70),88);
});

test('permission to compile permits R3 but never permits executing the resulting tasks',t=>{
  const {store}=fixture(t);
  store.write({id:'reader-pilot:p',kind:'reader-pilot',expected:0,value:{projectId:'p',experimental:true,active:true,stopAfter:'L2',reader:{...role,actor:'reader',speed:'fast'},agentCommand:role.command,maxRequestChars:300000,maxReadChars:60000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:10000000}});
  configurePhasePolicy(store,'p','compilation','R2-L3',0);
  for (const phase of ['R2','L3','R3']) assert.doesNotThrow(()=>assertPilotBoundary(store,'p',phase));
  assert.throws(()=>assertPilotBoundary(store,'p','execution'),{code:'pilot_boundary_reached'});
});

test('actual question overshoot pauses and cannot be legalized retrospectively by an automatic increase',t=>{
  const {store,basis}=fixture(t);
  const estimate={kind:'estimated' as const,tokens:100,basis:[reference(basis)],explanation:'test'};
  const reservation=prepareNewSegmentReservation(store,{projectId:'p',key:'R2-L3',limit:1000,initialGroupLimit:700,completionReserve:0},'overshoot',['g'],estimate);
  store.writeMany([{id:'overshoot',kind:'model-call',expected:0,value:{...call('overshoot'),status:'succeeded',usage:{inputTokens:750,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}}},...reservation.writes],reservation.guards);
  const segment=budgetSegment(store,'p','R2-L3');
  assert.throws(()=>assertQuestionBudget(store,segment,['g']),{code:'budget_question_overrun'});
  assert.throws(()=>reserveResearchCall(store,{saved:segment},'next',['g'],estimate),{code:'budget_question_limit'});
  assert.equal(workingLimit(store,segment,'g','tokens',700),700);
});

test('identical Codex adapter bytes remain comparable across temporary build directories',t=>{
  const {store,root}=fixture(t);
  const a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b);
  const left=join(a,'codex-stdio.js'),right=join(b,'codex-stdio.js');
  writeFileSync(left,'// same adapter');writeFileSync(right,'// same adapter');
  const oldRole={...role,command:{executable:process.execPath,args:[left,'--compact-research']}};
  store.write({id:'relocated-sample',kind:'model-call',expected:0,value:{...call('relocated-sample'),requested:oldRole,status:'succeeded',finishedAt:2,usage:{inputTokens:200,outputTokens:100,cachedInputTokens:0,reasoningOutputTokens:0}}});
  const newRole={...oldRole,command:{...oldRole.command,args:[right,'--compact-research']}};
  assert.equal(estimateCliCall(store,'p',newRole,'analyst',1000).tokens,330);
  writeFileSync(right,'// different adapter');
  assert.throws(()=>estimateCliCall(store,'p',newRole,'analyst',1000),{code:'budget_estimate_missing'});
});

test('smaller continuations use measured input density without pretending output or overhead vanishes',t=>{
 const {store}=fixture(t);
 for(const [id,chars,input] of [['small',1000,1000],['large',10000,5000]] as const)
  store.write({id,kind:'model-call',expected:0,value:{...call(id),request:{chars,bytes:chars,hash:hashJson(id)},status:'succeeded',usage:{inputTokens:input,outputTokens:100,cachedInputTokens:0,reasoningOutputTokens:0}}});
 const estimate=estimateCliCall(store,'p',role,'analyst',2000,'continuation');
 assert.equal(estimate.kind,'estimated');assert.equal(estimate.tokens,2310);
 assert.equal(estimateCliCall(store,'p',role,'analyst',10,'continuation').tokens,1210);
});

test('zero measured input cannot become an output-only continuation estimate',t=>{
 const {store}=fixture(t);
 store.write({id:'zero-input',kind:'model-call',expected:0,value:{...call('zero-input'),status:'succeeded',usage:{inputTokens:0,outputTokens:100,cachedInputTokens:0,reasoningOutputTokens:0}}});
 assert.throws(()=>estimateCliCall(store,'p',role,'analyst',1000,'continuation'),{code:'budget_estimate_missing'});
});

test('owner block ceilings are explicit, validated and immutable on current segments', t => {
  const { store, basis } = fixture(t);
  const estimate = { kind: 'estimated' as const, tokens: 1, basis: [reference(basis)], explanation: 'fixture' };
  // A current segment without an owner block ceiling retains its plain working policy.
  const plain = prepareNewSegmentReservation(store, { projectId: 'p', key: 'R2-L3', limit: 20_000_000, initialGroupLimit: 700_000, completionReserve: 0 }, 'plain-call', ['g'], estimate);
  store.writeMany([{ id: 'plain-call', kind: 'model-call', expected: 0, value: call('plain-call') }, ...plain.writes], plain.guards);
  const plainSegment = budgetSegment(store, 'p', 'R2-L3');
  assert.equal(Object.hasOwn(plainSegment.value, 'ownerGroupCeiling'), false);
  assert.equal(workingLimit(store, plainSegment, 'g', 'tokens', 900), 900);
  for (const invalid of [0, -1, 1.5, 699_999, 20_000_001, NaN, null]) {
    assert.throws(() => reserveResearchCall(store, { creating: { projectId: 'p', key: 'invalid', limit: 20_000_000, initialGroupLimit: 700_000, completionReserve: 0, ownerGroupCeiling: invalid as number } }, 'c', ['g'], estimate),
      { code: 'budget_owner_ceiling_invalid' });
  }
  const capped = prepareNewSegmentReservation(store, { projectId: 'p', key: 'owner-capped', limit: 20_000_000, initialGroupLimit: 700_000, completionReserve: 0, ownerGroupCeiling: 800_000 }, 'capped-call', ['g'], estimate);
  store.writeMany([{ id: 'capped-call', kind: 'model-call', expected: 0, value: call('capped-call') }, ...capped.writes], capped.guards);
  const segment = budgetSegment(store, 'p', 'owner-capped');
  assert.equal(segment.value.ownerGroupCeiling, 800_000);
  // Recreating the same key cannot reset the ceiling: the second creation loses on CAS.
  const replay = prepareNewSegmentReservation(store, { projectId: 'p', key: 'owner-capped', limit: 20_000_000, initialGroupLimit: 700_000, completionReserve: 0, ownerGroupCeiling: 900_000 }, 'replay-call', ['g'], estimate);
  assert.throws(() => store.writeMany([{ id: 'replay-call', kind: 'model-call', expected: 0, value: call('replay-call') }, ...replay.writes], replay.guards), { code: 'revision_conflict' });
  // In-memory masquerade is rejected by hash mismatch.
  const masquerade = { ...segment, value: { ...segment.value, ownerGroupCeiling: 900_000 } };
  assert.throws(() => reserveResearchCall(store, { saved: masquerade }, 'forged-call', ['g'], estimate), { code: 'budget_segment_invalid' });
  // Removal of the ceiling on a segment that had it is a typed refusal.
  const { ownerGroupCeiling: _removed, ...withoutCeiling } = segment.value;
  store.write({ id: segment.id, kind: segment.kind, expected: segment.revision, value: withoutCeiling });
  assert.throws(() => budgetSegment(store, 'p', 'owner-capped'), { code: 'budget_owner_ceiling_changed' });
  const changed = store.write<BudgetSegment>({ id: segment.id, kind: segment.kind, expected: 2,
    value: { ...segment.value, ownerGroupCeiling: 900_000 } });
  assert.throws(() => reserveResearchCall(store, { saved: changed }, 'changed-call', ['g'], estimate), { code: 'budget_owner_ceiling_changed' });
  assert.equal(store.get('forged-call'), null);
  assert.equal(store.get('changed-call'), null);
});

test('working increases include their safety margin inside the owner ceiling and cannot raise it with a larger physical maximum', t => {
  const { store, basis } = fixture(t);
  const segment = seedSegment(store, basis, 'raises', 20_000_000, 700_000, 0, 800_000);
  const decision: Optimization = { reason: 'remaining synthesis', progress: 'new exact evidence', required: 720_000,
    obligations: ['exceptions', 'consumers'], forecast: 'remaining roles included', basis: [reference(basis)],
    options: [{ method: 'deduplicate originals', saved: 100, decision: 'accept', quality: 'all obligations retained', preserved: ['exceptions', 'consumers'] }] };
  const raised = raiseWorkingLimit(store, segment, 'g', 'tokens', 700_000, decision, 2_000_000);
  assert.equal(raised.value.limit, 792_000);
  assert.equal(raised.value.ceiling, 800_000);
  assert.throws(() => raiseWorkingLimit(store, segment, 'other', 'tokens', 700_000,
    { ...decision, required: 730_000 }, 2_000_000), { code: 'budget_owner_group_limit' });
  assert.throws(() => raiseWorkingLimit(store, segment, 'g', 'tokens', 700_000,
    { ...decision, progress: 'additional evidence', required: 800_000 }, 20_000_000), { code: 'budget_owner_group_limit' });
  assert.equal(workingLimit(store, segment, 'g', 'tokens', 700_000), 792_000);
  assert.equal(store.get(segment.id)!.revision, 1);
  // Character limits are a different unit and retain their declared transport policy.
  assert.equal(raiseWorkingLimit(store, segment, 'g', 'requestChars', 700_000,
    { ...decision, required: 800_000 }, 1_000_000).value.limit, 880_000);
});

test('all roles, failed calls and unknown usage share one block ceiling even with unused stage funds', t => {
  const { store, basis } = fixture(t);
  const estimate = { kind: 'estimated' as const, tokens: 200_000, basis: [reference(basis)], explanation: 'full role cost' };
  const creating = { projectId: 'p', key: 'all-roles', limit: 20_000_000, initialGroupLimit: 800_000, completionReserve: 0, ownerGroupCeiling: 800_000 };
  const first = prepareNewSegmentReservation(store, creating, 'role-reading-planner', ['stable-block', 'shared-consumer'], estimate);
  store.writeMany([{ id: 'role-reading-planner', kind: 'model-call', expected: 0,
    value: { ...call('role-reading-planner'), purpose: 'reading-planner', status: 'succeeded', finishedAt: 2,
      usage: { inputTokens: 150_000, outputTokens: 50_000, cachedInputTokens: 50_000, reasoningOutputTokens: 20_000 } } },
  ...first.writes], first.guards);
  const segment = budgetSegment(store, 'p', 'all-roles');
  for (const [index, purpose] of ['reader', 'analyst', 'assessor'].entries()) {
    const id = `role-${purpose}`;
    const reservation = reserveResearchCall(store, { saved: segment }, id, ['stable-block', 'shared-consumer'], estimate);
    store.writeMany([{ id, kind: 'model-call', expected: 0, value: { ...call(id), purpose,
      ...(index < 2 ? { status: index === 1 ? 'failed' : 'succeeded', finishedAt: 2,
        usage: { inputTokens: 150_000, outputTokens: 50_000, cachedInputTokens: 50_000, reasoningOutputTokens: 20_000 } } : {}) } },
    ...reservation.writes], reservation.guards);
  }
  const usage = budgetUsage(store, segment);
  assert.deepEqual(usage.groups['stable-block'], { measured: 600_000, reserved: 200_000 });
  assert.deepEqual(usage.groups['shared-consumer'], usage.groups['stable-block']);
  assert.equal(usage.measured, 600_000); assert.equal(usage.reserved, 200_000);
  assert.equal(usage.remaining, 19_200_000);
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'retry', ['stable-block'], { ...estimate, tokens: 1 }),
    { code: 'budget_owner_group_limit' });
  const assessor = store.get<ModelCall>('role-assessor')!;
  store.write({ id: assessor.id, kind: assessor.kind, expected: assessor.revision,
    value: { ...assessor.value, status: 'failed', finishedAt: 2 } });
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'retry-after-failure', ['stable-block'], { ...estimate, tokens: 1 }),
    { code: 'budget_owner_group_limit' });
  const failed = store.get<ModelCall>(assessor.id)!;
  store.write({ id: failed.id, kind: failed.kind, expected: failed.revision, value: { ...failed.value,
    usage: { inputTokens: 100_000, outputTokens: 50_000, cachedInputTokens: 0, reasoningOutputTokens: 0 } } });
  assert.doesNotThrow(() => assertQuestionBudget(store, segment, ['stable-block']));
  const last = reserveResearchCall(store, { saved: segment }, 'last', ['stable-block'], { ...estimate, tokens: 50_000 });
  store.writeMany([{ id: 'last', kind: 'model-call', expected: 0, value: call('last') }, ...last.writes], last.guards);
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'extra', ['stable-block'], { ...estimate, tokens: 1 }),
    { code: 'budget_owner_group_limit' });
  assert.equal(store.get('extra'), null);
  assert.doesNotThrow(() => reserveResearchCall(store, { saved: segment }, 'other-block', ['other-block'], estimate));
});

test('an oversized saved working limit cannot hide a block overrun or admit another call', t => {
  const { store, basis } = fixture(t);
  const segId = segmentId('p', 'reconcile');
  store.write({ id: `research-limit:${hashJson([segId, 'g', 'tokens'])}`, kind: 'research-limit', expected: 0,
    value: { projectId: 'p', segment: segId, group: 'g', metric: 'tokens', limit: 2_000_000, ceiling: 2_000_000, decisions: [] } });
  const cappedCreating = { projectId: 'p', key: 'reconcile', limit: 20_000_000, initialGroupLimit: 800_000, completionReserve: 0, ownerGroupCeiling: 800_000 };
  const estimate = { kind: 'estimated' as const, tokens: 800_001, basis: [reference(basis)], explanation: 'fixture' };
  assert.throws(() => reserveResearchCall(store, { creating: cappedCreating }, 'too-large', ['g'], estimate), { code: 'budget_owner_group_limit' });
  const reservation = prepareNewSegmentReservation(store, cappedCreating, 'overrun', ['g'], { ...estimate, tokens: 100_000 });
  store.writeMany([{ id: 'overrun', kind: 'model-call', expected: 0, value: { ...call('overrun'), status: 'succeeded', finishedAt: 2,
    usage: { inputTokens: 800_000, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } } }, ...reservation.writes], reservation.guards);
  const segment = budgetSegment(store, 'p', 'reconcile');
  assert.equal(workingLimit(store, segment, 'g', 'tokens', 2_000_000), 800_000);
  assert.equal(workingLimit(store, segment, 'g,fresh', 'tokens', 2_000_000), 800_000);
  assert.equal(budgetUsage(store, segment).measured, 800_001);
  assert.equal(budgetUsage(store, segment).remaining, 19_199_999);
  assert.throws(() => assertQuestionBudget(store, segment, ['g']), { code: 'budget_owner_group_overrun' });
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'after-overrun', ['g'], { ...estimate, tokens: 1 }), { code: 'budget_owner_group_limit' });
});

test('completion reserve is mandatory, validated and immutable; a missing reserve is a typed refusal', t => {
  const { store, basis } = fixture(t);
  const estimate = { kind: 'estimated' as const, tokens: 1, basis: [reference(basis)], explanation: 'fixture' };

  // A pre-DR3c segment saved without completionReserve is only a negative
  // counterexample: reading its policy and new reservations are typed refusals,
  // and nothing is written.
  store.write({ id: segmentId('p', 'legacy'), kind: 'research-budget', expected: 0,
    value: { projectId: 'p', key: 'legacy', limit: 10_000_000, initialGroupLimit: 700_000 } as unknown as BudgetSegment });
  const legacy = store.get<BudgetSegment>(segmentId('p', 'legacy'))!;
  assert.throws(() => budgetSegment(store, 'p', 'legacy'), { code: 'budget_completion_reserve_invalid' });
  assert.throws(() => segmentCompletionReserve(store, legacy), { code: 'budget_completion_reserve_invalid' });
  assert.throws(() => reserveResearchCall(store, { saved: legacy }, 'legacy-call', ['g'], estimate), { code: 'budget_completion_reserve_invalid' });
  assert.equal(store.get('legacy-call'), null);

  // Adding a numeric completionReserve to a segment whose original policy has
  // no reserve is the same immutability refusal, never a repair.
  const legacyAdded = store.write<BudgetSegment>({ id: legacy.id, kind: legacy.kind, expected: legacy.revision,
    value: { ...legacy.value, completionReserve: 500 } });
  const callsAfterLegacyAdded = store.list('model-call').length;
  const ledgersAfterLegacyAdded = store.list('research-budget-ledger').length;
  assert.throws(() => reserveResearchCall(store, { saved: legacyAdded }, 'legacy-added-call', ['g'], estimate), { code: 'budget_completion_reserve_changed' });
  assert.equal(store.get('legacy-added-call'), null);
  assert.equal(store.list('model-call').length, callsAfterLegacyAdded);
  assert.equal(store.list('research-budget-ledger').length, ledgersAfterLegacyAdded);

  const base = { projectId: 'p', key: 'with-reserve', limit: 10_000_000, initialGroupLimit: 700_000 };
  for (const invalid of [-1, 1.5, NaN, null as unknown as number, 20_000_001, '500' as unknown as number]) {
    assert.throws(() => prepareNewSegmentReservation(store, { ...base, key: 'invalid-reserve', completionReserve: invalid }, 'c0', ['g'], estimate),
      { code: 'budget_completion_reserve_invalid' });
    assert.throws(() => reserveResearchCall(store, { creating: { ...base, key: 'invalid-reserve', completionReserve: invalid } }, 'c0-res', ['g'], estimate),
      { code: 'budget_completion_reserve_invalid' });
  }
  assert.equal(store.get(segmentId('p', 'invalid-reserve')), null);

  // Explicit 0 is a lawful reserve and keeps the whole segment available to research.
  const zero = prepareNewSegmentReservation(store, { ...base, key: 'zero-reserve', initialGroupLimit: 10_000_000, completionReserve: 0 }, 'call-zero', ['g'], estimate);
  store.writeMany([{ id: 'call-zero', kind: 'model-call', expected: 0, value: call('call-zero') }, ...zero.writes], zero.guards);
  const zeroSaved = budgetSegment(store, 'p', 'zero-reserve');
  assert.equal(zeroSaved.value.completionReserve, 0);
  assert.equal(segmentCompletionReserve(store, zeroSaved), 0);
  assert.doesNotThrow(() => reserveResearchCall(store, { saved: zeroSaved }, 'zero-full', ['g'],
    { kind: 'estimated', tokens: 9_500_000, basis: [reference(basis)], explanation: 'full' }, 'research'));

  // The exact limit is a lawful reserve: research refuses, completion admits the full limit.
  assert.throws(() => prepareNewSegmentReservation(store, { ...base, key: 'full-reserve', initialGroupLimit: 10_000_000, completionReserve: 10_000_000 }, 'call-full-res', ['g'],
    { kind: 'estimated', tokens: 1, basis: [reference(basis)], explanation: '1 token' }, 'research'), { code: 'budget_segment_exhausted' });
  const fullPrep = prepareNewSegmentReservation(store, { ...base, key: 'full-reserve', initialGroupLimit: 10_000_000, completionReserve: 10_000_000 }, 'call-full-comp', ['g'],
    { kind: 'estimated', tokens: 10_000_000, basis: [reference(basis)], explanation: 'full' }, 'completion');
  store.writeMany([{ id: 'call-full-comp', kind: 'model-call', expected: 0, value: call('call-full-comp') }, ...fullPrep.writes], fullPrep.guards);
  const fullSaved = budgetSegment(store, 'p', 'full-reserve');
  assert.equal(fullSaved.value.completionReserve, 10_000_000);
  assert.equal(segmentCompletionReserve(store, fullSaved), 10_000_000);

  // A bound reserve is validated, exposed and immutable.
  const bound = prepareNewSegmentReservation(store, { ...base, key: 'bound-reserve', completionReserve: 2_000_000 }, 'seed-bound', ['g'], estimate);
  store.writeMany([{ id: 'seed-bound', kind: 'model-call', expected: 0, value: call('seed-bound') }, ...bound.writes], bound.guards);
  const segment = budgetSegment(store, 'p', 'bound-reserve');
  assert.equal(segment.value.completionReserve, 2_000_000);
  assert.equal(segmentCompletionReserve(store, segment), 2_000_000);

  // In-memory masquerade is rejected by hash mismatch.
  const masquerade = { ...segment, value: { ...segment.value, completionReserve: 0 } };
  assert.throws(() => reserveResearchCall(store, { saved: masquerade }, 'forged-call', ['g'], estimate), { code: 'budget_segment_invalid' });

  // Removal of completionReserve on a segment that had it is a typed refusal, never fallback to 0.
  const { completionReserve: _removed, ...withoutReserve } = segment.value;
  store.write({ id: segment.id, kind: segment.kind, expected: segment.revision,
    value: withoutReserve as unknown as BudgetSegment });
  assert.throws(() => budgetSegment(store, 'p', 'bound-reserve'), { code: 'budget_completion_reserve_changed' });
  assert.throws(() => reserveResearchCall(store, { saved: store.get<BudgetSegment>(segment.id)! }, 'call-no-reserve', ['g'], estimate),
    { code: 'budget_completion_reserve_changed' });

  // Changing completionReserve in a later revision is a typed refusal.
  const changed = store.write<BudgetSegment>({ id: segment.id, kind: segment.kind, expected: 2,
    value: { ...segment.value, completionReserve: 3_000_000 } });
  assert.throws(() => reserveResearchCall(store, { saved: changed }, 'changed-call', ['g'], estimate), { code: 'budget_completion_reserve_changed' });
});

test('classification research stays inside limit minus reserve while completion uses full limit, refusing both after overrun', t => {
  const { store, basis } = fixture(t);
  const creating = { projectId: 'p', key: 'split-headroom', limit: 10_000_000, initialGroupLimit: 10_000_000, completionReserve: 2_000_000 };
  const estimate = { kind: 'estimated' as const, tokens: 7_500_000, basis: [reference(basis)], explanation: 'research batch' };

  // Invalid classification is a typed refusal
  assert.throws(() => reserveResearchCall(store, { creating }, 'invalid-class', ['g'], estimate, 'other' as unknown as 'research'),
    { code: 'budget_class_invalid' });

  // Research reserve of 7.5M fits in limit - R (10M - 2M = 8M); this first call creates the segment.
  const res1 = prepareNewSegmentReservation(store, creating, 'c1', ['g'], estimate, 'research');
  store.writeMany([{ id: 'c1', kind: 'model-call', expected: 0, value: call('c1') }, ...res1.writes], res1.guards);
  const segment = budgetSegment(store, 'p', 'split-headroom');

  // Next research of 600k would reach 8.1M > 8M -> refuses budget_segment_exhausted
  const estNext = { kind: 'estimated' as const, tokens: 600_000, basis: [reference(basis)], explanation: 'next chunk' };
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'c2-res', ['g'], estNext, 'research'),
    { code: 'budget_segment_exhausted' });

  // Default classification is 'research'
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'c2-def', ['g'], estNext),
    { code: 'budget_segment_exhausted' });

  // Completion reserve of 600k fits in full limit (7.5M + 600k = 8.1M <= 10M)
  const res2 = reserveResearchCall(store, { saved: segment }, 'c2-comp', ['g'], estNext, 'completion');
  store.writeMany([{ id: 'c2-comp', kind: 'model-call', expected: 0, value: call('c2-comp') }, ...res2.writes], res2.guards);

  // Completion call exceeding full limit (8.1M + 2M = 10.1M > 10M) refuses budget_segment_exhausted
  const estOver = { kind: 'estimated' as const, tokens: 2_000_000, basis: [reference(basis)], explanation: 'exceed full' };
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'c3-comp', ['g'], estOver, 'completion'),
    { code: 'budget_segment_exhausted' });

  // Two reservations prepared against the same ledger snapshot conflict on CAS
  const estSmall = { kind: 'estimated' as const, tokens: 100_000, basis: [reference(basis)], explanation: 'small' };
  const left = reserveResearchCall(store, { saved: segment }, 'snap-left', ['g'], estSmall, 'completion');
  const right = reserveResearchCall(store, { saved: segment }, 'snap-right', ['g'], estSmall, 'completion');
  store.writeMany([{ id: 'snap-left', kind: 'model-call', expected: 0, value: call('snap-left') }, ...left.writes], left.guards);
  assert.throws(() => store.writeMany([{ id: 'snap-right', kind: 'model-call', expected: 0, value: call('snap-right') }, ...right.writes], right.guards),
    { code: 'revision_conflict' });

  // Failed call with usage: null holds its reserve
  const c1 = store.get<ModelCall>('c1')!;
  store.write({ id: 'c1', kind: 'model-call', expected: c1.revision, value: { ...c1.value, status: 'failed', finishedAt: 2 } });
  assert.equal(budgetUsage(store, segment).reserved >= 7_500_000, true);
  // Still cannot allocate more research tokens
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'c-after-fail', ['g'], estNext, 'research'),
    { code: 'budget_segment_exhausted' });

  // Succeeded call with actual overrun (measured > limit) blocks both research and completion
  const c2 = store.get<ModelCall>('c2-comp')!;
  store.write({ id: 'c2-comp', kind: 'model-call', expected: c2.revision,
    value: { ...c2.value, status: 'succeeded', finishedAt: 3, usage: { inputTokens: 11_000_000, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 } } });
  assert.equal(budgetUsage(store, segment).remaining < 0, true);

  const estMin = { kind: 'estimated' as const, tokens: 1, basis: [reference(basis)], explanation: 'minimal' };
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'after-overrun-res', ['g'], estMin, 'research'),
    { code: 'budget_segment_exhausted' });
  assert.throws(() => reserveResearchCall(store, { saved: segment }, 'after-overrun-comp', ['g'], estMin, 'completion'),
    { code: 'budget_segment_exhausted' });
});

test('atomic preparation of new segment and first reserve returns expected:0 without existing segment guards and resolves races', t => {
  const { store, basis } = fixture(t);
  const estimate = { kind: 'estimated' as const, tokens: 500_000, basis: [reference(basis)], explanation: 'first reserve' };

  const creating: NewBudgetSegment = {
    projectId: 'p',
    key: 'fresh-stage',
    limit: 10_000_000,
    initialGroupLimit: 10_000_000,
    completionReserve: 2_000_000
  };

  // Validation on creating target
  assert.throws(() => prepareNewSegmentReservation(store, { ...creating, limit: 0 }, 'c0', ['g'], estimate),
    { code: 'budget_invalid' });
  assert.throws(() => prepareNewSegmentReservation(store, { ...creating, completionReserve: -1 }, 'c0', ['g'], estimate),
    { code: 'budget_completion_reserve_invalid' });
  assert.throws(() => prepareNewSegmentReservation(store, { ...creating, completionReserve: 10_000_001 }, 'c0', ['g'], estimate),
    { code: 'budget_completion_reserve_invalid' });
  assert.throws(() => prepareNewSegmentReservation(store, { ...creating, ownerGroupCeiling: 20_000_000 }, 'c0', ['g'], estimate),
    { code: 'budget_owner_ceiling_invalid' });

  // Missing or undefined completionReserve on creating target is a typed refusal across both entrypoints
  const { completionReserve: _omitted, ...missingReserve } = creating;
  assert.throws(() => prepareNewSegmentReservation(store, missingReserve as unknown as NewBudgetSegment, 'c-missing', ['g'], estimate),
    { code: 'budget_completion_reserve_invalid' });
  assert.throws(() => prepareNewSegmentReservation(store, { ...creating, completionReserve: undefined as unknown as number }, 'c-undef', ['g'], estimate),
    { code: 'budget_completion_reserve_invalid' });
  assert.throws(() => reserveResearchCall(store, { creating: missingReserve as unknown as NewBudgetSegment }, 'c-missing-res', ['g'], estimate, 'research'),
    { code: 'budget_completion_reserve_invalid' });
  assert.throws(() => reserveResearchCall(store, { creating: { ...creating, completionReserve: undefined as unknown as number } }, 'c-undef-res', ['g'], estimate, 'research'),
    { code: 'budget_completion_reserve_invalid' });
  assert.equal(store.get(segmentId('p', missingReserve.key)), null);
  assert.equal(store.get(`research-budget-ledger:${hashJson(segmentId('p', missingReserve.key))}`), null);
  assert.equal(store.get('c-missing'), null);
  assert.equal(store.get('c-missing-res'), null);

  // Positive controls of explicit R=0 and R=limit through creating
  const zeroCreating: NewBudgetSegment = { projectId: 'p', key: 'zero-creating', limit: 10_000_000, initialGroupLimit: 10_000_000, completionReserve: 0 };
  const zeroPrep = prepareNewSegmentReservation(store, zeroCreating, 'call-zero', ['g'], estimate, 'research');
  store.writeMany([{ id: 'call-zero', kind: 'model-call', expected: 0, value: call('call-zero') }, ...zeroPrep.writes], zeroPrep.guards);
  const zeroSaved = budgetSegment(store, 'p', 'zero-creating');
  assert.equal(zeroSaved.value.completionReserve, 0);
  assert.equal(segmentCompletionReserve(store, zeroSaved), 0);
  assert.doesNotThrow(() => reserveResearchCall(store, { saved: zeroSaved }, 'zero-full', ['g'], { kind: 'estimated', tokens: 9_500_000, basis: [reference(basis)], explanation: 'full' }, 'research'));

  // The removed positional form is a typed refusal, not a TypeError: a bare
  // Revision or an empty target cannot reach any reservation path.
  assert.throws(() => reserveResearchCall(store, zeroSaved as unknown as BudgetSegmentTarget, 'bare-revision', ['g'], estimate),
    { code: 'budget_segment_invalid' });
  assert.throws(() => reserveResearchCall(store, {} as BudgetSegmentTarget, 'empty-target', ['g'], estimate),
    { code: 'budget_segment_invalid' });
  assert.equal(store.get('bare-revision'), null);
  assert.equal(store.get('empty-target'), null);

  const fullCreating: NewBudgetSegment = { projectId: 'p', key: 'full-creating', limit: 10_000_000, initialGroupLimit: 10_000_000, completionReserve: 10_000_000 };
  assert.throws(() => prepareNewSegmentReservation(store, fullCreating, 'call-full-res', ['g'], { kind: 'estimated', tokens: 1, basis: [reference(basis)], explanation: '1 token' }, 'research'),
    { code: 'budget_segment_exhausted' });
  const fullPrep = prepareNewSegmentReservation(store, fullCreating, 'call-full-comp', ['g'], { kind: 'estimated', tokens: 10_000_000, basis: [reference(basis)], explanation: 'full' }, 'completion');
  store.writeMany([{ id: 'call-full-comp', kind: 'model-call', expected: 0, value: call('call-full-comp') }, ...fullPrep.writes], fullPrep.guards);
  const fullSaved = budgetSegment(store, 'p', 'full-creating');
  assert.equal(fullSaved.value.completionReserve, 10_000_000);
  assert.equal(segmentCompletionReserve(store, fullSaved), 10_000_000);

  // Research exceeding limit - R on creating is refused
  const estTooBig = { kind: 'estimated' as const, tokens: 8_000_001, basis: [reference(basis)], explanation: 'too big' };
  assert.throws(() => prepareNewSegmentReservation(store, creating, 'c-too-big', ['g'], estTooBig, 'research'),
    { code: 'budget_segment_exhausted' });

  // Completion on creating can use full limit
  const estComp = { kind: 'estimated' as const, tokens: 8_500_000, basis: [reference(basis)], explanation: 'completion fits' };
  const compPrep = prepareNewSegmentReservation(store, creating, 'c-comp', ['g'], estComp, 'completion');
  assert.equal(compPrep.writes.length, 2);
  assert.equal(compPrep.writes[0]!.expected, 0);
  assert.equal(compPrep.writes[1]!.expected, 0);
  // Guards must contain basis but NOT reference(segment)
  assert.equal(compPrep.guards.some(g => 'revision' in g && g.id.startsWith('research-budget:')), false);

  // Normal preparation
  const prep = prepareNewSegmentReservation(store, creating, 'first-call', ['g'], estimate, 'research');
  assert.equal(prep.writes.length, 2);
  assert.equal(prep.writes[0]!.kind, 'research-budget');
  assert.equal(prep.writes[0]!.expected, 0);
  assert.equal(prep.writes[1]!.kind, 'research-budget-ledger');
  assert.equal(prep.writes[1]!.expected, 0);
  // No segment guard because segment does not yet exist
  assert.equal(prep.guards.some(g => 'revision' in g && g.id === prep.writes[0]!.id), false);

  // Two concurrent stores prepare creating reservation for the same key
  const other = new Store(store.path);
  t.after(() => other.close());
  const otherPrep = prepareNewSegmentReservation(other, creating, 'other-call', ['g'], estimate, 'research');

  // First commits: model-call, segment, and ledger are all written in one transaction
  store.writeMany([{ id: 'first-call', kind: 'model-call', expected: 0, value: call('first-call') }, ...prep.writes], prep.guards);
  assert.equal(store.get<ModelCall>('first-call')!.value.status, 'running');
  assert.equal(store.get(prep.writes[0]!.id)!.revision, 1);
  assert.equal(store.get(prep.writes[1]!.id)!.revision, 1);

  // Second store commit fails with revision_conflict
  assert.throws(() => other.writeMany([{ id: 'other-call', kind: 'model-call', expected: 0, value: call('other-call') }, ...otherPrep.writes], otherPrep.guards),
    { code: 'revision_conflict' });
  // Loser writes nothing: neither call, nor second segment, nor second ledger
  assert.equal(store.get('other-call'), null);
  assert.equal(store.get(prep.writes[0]!.id)!.revision, 1);

  // Subsequent call uses { saved: Revision<BudgetSegment> }
  const savedSegment = budgetSegment(store, 'p', 'fresh-stage');
  const target: BudgetSegmentTarget = { saved: savedSegment };
  const nextRes = reserveResearchCall(store, target, 'second-call', ['g'], estimate, 'research');
  assert.equal(nextRes.writes.length, 1);
  assert.equal(nextRes.writes[0]!.expected, 1);
  assert.equal(nextRes.guards.some(g => 'revision' in g && g.id === savedSegment.id), true);
});