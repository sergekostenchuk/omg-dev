import { estimateCliCall } from "../src/adapters/codex-estimate.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { configureBudgetSegment, budgetSegment, reserveResearchCall, budgetUsage, raiseWorkingLimit, workingLimit, assertQuestionBudget, budgetGroups, type BudgetSegment, type Optimization } from '../src/runtime/research-budget.js';
import { assertPilotBoundary } from '../src/discovery/reader-pilot.js';
import { configurePhasePolicy } from '../src/discovery/phase-policy.js';
import { scopeObligations, type ResearchScope } from '../src/graph/research-scope.js';
import type { ModelCall } from '../src/runtime/model-usage.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(),'omg-budget-'));
  const store = new Store(join(root,'state.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const segment = configureBudgetSegment(store,'p','R2-L3',1000,700);
  const basis = store.write({id:'basis',kind:'source',expected:0,value:{proof:'fixture'}});
  return {store,segment,basis,root};
}
const role = {actor:'a',model:'fixture',effort:'high' as const,command:{executable:process.execPath,args:[]}};
function call(id: string): ModelCall { return {projectId:'p',draftId:'d',purpose:'analyst',requestId:id,startedAt:1,finishedAt:null,status:'running',requested:role,
  confirmed:{model:null,effort:null,speed:null},request:{chars:1000,bytes:1000,hash:hashJson(id)},response:null,usage:null,usageSource:'unavailable',error:null}; }

test('concurrent reservations cannot share the remaining budget; unknown usage holds the original reserve',t=>{
  const {store,segment,basis}=fixture(t);
  const estimate={kind:'estimated' as const,tokens:600,basis:[reference(basis)],explanation:'fixture estimate'};
  const left=reserveResearchCall(store,segment,'c1',['g1'],estimate), right=reserveResearchCall(store,segment,'c2',['g2'],estimate);
  store.writeMany([{id:'c1',kind:'model-call',expected:0,value:call('c1')},...left.writes],left.guards);
  assert.throws(()=>store.writeMany([{id:'c2',kind:'model-call',expected:0,value:call('c2')},...right.writes],right.guards),{code:'revision_conflict'});
  assert.equal(store.get('c2'),null);
  const current=store.get<ModelCall>('c1')!;
  store.write({id:'c1',kind:'model-call',expected:current.revision,value:{...current.value,status:'failed',finishedAt:2}});
  assert.equal(budgetUsage(store,segment).reserved,600);
  assert.throws(()=>reserveResearchCall(store,segment,'c3',['g2'],estimate),{code:'budget_segment_exhausted'});
  const failed=store.get<ModelCall>('c1')!;
  store.write({id:'c1',kind:'model-call',expected:failed.revision,value:{...failed.value,usage:{inputTokens:200,outputTokens:100,cachedInputTokens:150,reasoningOutputTokens:20}}});
  const usage=budgetUsage(store,segment);
  assert.equal(usage.measured,300); assert.equal(usage.reserved,0); assert.equal(usage.remaining,700);
});

test('working limit uses required need plus ten percent, rejects missing exceptions and repeated progress',t=>{
  const {store,basis}=fixture(t), segment=configureBudgetSegment(store,'p','large');
  const decision: Optimization={reason:'necessary remaining work',progress:'new-source',required:800000,obligations:['exception','external-consumer'],forecast:'measured plus remaining roles',basis:[reference(basis)],
    options:[{method:'exact-dedup',saved:100,decision:'accept',quality:'all original obligations retained',preserved:['exception','external-consumer']}]};
  const changed=raiseWorkingLimit(store,segment,'g','tokens',700000,decision,900000);
  assert.equal(changed.value.limit,880000);
});

test('foreign/missing estimates and loss of constraints are typed refusals',t=>{
  const {store,segment,basis}=fixture(t);
  assert.throws(()=>reserveResearchCall(store,segment,'c',['g'],{kind:'estimated',tokens:0,basis:[],explanation:''}),{code:'budget_estimate_missing'});
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
  const {store,segment,basis}=fixture(t);
  const reservation=reserveResearchCall(store,segment,'overflow',['g'],{kind:'estimated',tokens:100,basis:[reference(basis)],explanation:'uncertain'});
  store.writeMany([{id:'overflow',kind:'model-call',expected:0,value:{...call('overflow'),status:'succeeded',usage:{inputTokens:1000,outputTokens:200,cachedInputTokens:0,reasoningOutputTokens:0}}},...reservation.writes],reservation.guards);
  assert.equal(budgetUsage(store,segment).remaining,-200);
  assert.throws(()=>reserveResearchCall(store,segment,'next',['g'],{kind:'estimated',tokens:1,basis:[reference(basis)],explanation:'minimum'}),{code:'budget_segment_exhausted'});
});

test('declared physical capacity blocks working expansion before a provider call and groups retain metric history',t=>{
  const {store,segment,basis}=fixture(t);
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
  const {store,segment,basis}=fixture(t);
  const estimate={kind:'estimated' as const,tokens:100,basis:[reference(basis)],explanation:'test'};
  const reservation=reserveResearchCall(store,segment,'overshoot',['g'],estimate);
  store.writeMany([{id:'overshoot',kind:'model-call',expected:0,value:{...call('overshoot'),status:'succeeded',usage:{inputTokens:750,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}}},...reservation.writes],reservation.guards);
  assert.throws(()=>assertQuestionBudget(store,segment,['g']),{code:'budget_question_overrun'});
  assert.throws(()=>reserveResearchCall(store,segment,'next',['g'],estimate),{code:'budget_question_limit'});
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

test('owner block ceilings are explicit, validated and immutable while original legacy segments remain compatible', t => {
  const { store, basis, segment: legacy } = fixture(t);
  assert.equal(Object.hasOwn(budgetSegment(store, 'p', 'R2-L3').value, 'ownerGroupCeiling'), false);
  assert.equal(workingLimit(store, legacy, 'g', 'tokens', 900), 900);
  for (const invalid of [0, -1, 1.5, 699_999, 20_000_001, NaN, null]) {
    assert.throws(() => configureBudgetSegment(store, 'p', 'invalid', 20_000_000, 700_000, invalid as number),
      { code: 'budget_owner_ceiling_invalid' });
  }
  const segment = configureBudgetSegment(store, 'p', 'owner-capped', 20_000_000, 700_000, 800_000);
  assert.equal(budgetSegment(store, 'p', 'owner-capped').value.ownerGroupCeiling, 800_000);
  assert.throws(() => configureBudgetSegment(store, 'p', 'owner-capped', 20_000_000, 700_000, 900_000),
    { code: 'revision_conflict' });
  const estimate = { kind: 'estimated' as const, tokens: 1, basis: [reference(basis)], explanation: 'fixture' };
  const masquerade = { ...segment, value: { ...segment.value, ownerGroupCeiling: 900_000 } };
  assert.throws(() => reserveResearchCall(store, masquerade, 'forged-call', ['g'], estimate), { code: 'budget_segment_invalid' });
  const { ownerGroupCeiling: _removed, ...withoutCeiling } = segment.value;
  store.write({ id: segment.id, kind: segment.kind, expected: segment.revision, value: withoutCeiling });
  assert.throws(() => budgetSegment(store, 'p', 'owner-capped'), { code: 'budget_owner_ceiling_changed' });
  const changed = store.write<BudgetSegment>({ id: segment.id, kind: segment.kind, expected: 2,
    value: { ...segment.value, ownerGroupCeiling: 900_000 } });
  assert.throws(() => reserveResearchCall(store, changed, 'changed-call', ['g'], estimate), { code: 'budget_owner_ceiling_changed' });
  assert.equal(store.get('forged-call'), null);
  assert.equal(store.get('changed-call'), null);
});

test('working increases include their safety margin inside the owner ceiling and cannot raise it with a larger physical maximum', t => {
  const { store, basis } = fixture(t);
  const segment = configureBudgetSegment(store, 'p', 'raises', 20_000_000, 700_000, 800_000);
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
  const segment = configureBudgetSegment(store, 'p', 'all-roles', 20_000_000, 800_000, 800_000);
  const estimate = { kind: 'estimated' as const, tokens: 200_000, basis: [reference(basis)], explanation: 'full role cost' };
  for (const [index, purpose] of ['reading-planner', 'reader', 'analyst', 'assessor'].entries()) {
    const id = `role-${purpose}`;
    const reservation = reserveResearchCall(store, segment, id, ['stable-block', 'shared-consumer'], estimate);
    store.writeMany([{ id, kind: 'model-call', expected: 0, value: { ...call(id), purpose,
      ...(index < 3 ? { status: index === 2 ? 'failed' : 'succeeded', finishedAt: 2,
        usage: { inputTokens: 150_000, outputTokens: 50_000, cachedInputTokens: 50_000, reasoningOutputTokens: 20_000 } } : {}) } },
    ...reservation.writes], reservation.guards);
  }
  const usage = budgetUsage(store, segment);
  assert.deepEqual(usage.groups['stable-block'], { measured: 600_000, reserved: 200_000 });
  assert.deepEqual(usage.groups['shared-consumer'], usage.groups['stable-block']);
  assert.equal(usage.measured, 600_000); assert.equal(usage.reserved, 200_000);
  assert.equal(usage.remaining, 19_200_000);
  assert.throws(() => reserveResearchCall(store, segment, 'retry', ['stable-block'], { ...estimate, tokens: 1 }),
    { code: 'budget_owner_group_limit' });
  const assessor = store.get<ModelCall>('role-assessor')!;
  store.write({ id: assessor.id, kind: assessor.kind, expected: assessor.revision,
    value: { ...assessor.value, status: 'failed', finishedAt: 2 } });
  assert.throws(() => reserveResearchCall(store, segment, 'retry-after-failure', ['stable-block'], { ...estimate, tokens: 1 }),
    { code: 'budget_owner_group_limit' });
  const failed = store.get<ModelCall>(assessor.id)!;
  store.write({ id: failed.id, kind: failed.kind, expected: failed.revision, value: { ...failed.value,
    usage: { inputTokens: 100_000, outputTokens: 50_000, cachedInputTokens: 0, reasoningOutputTokens: 0 } } });
  assert.doesNotThrow(() => assertQuestionBudget(store, segment, ['stable-block']));
  const last = reserveResearchCall(store, segment, 'last', ['stable-block'], { ...estimate, tokens: 50_000 });
  store.writeMany([{ id: 'last', kind: 'model-call', expected: 0, value: call('last') }, ...last.writes], last.guards);
  assert.throws(() => reserveResearchCall(store, segment, 'extra', ['stable-block'], { ...estimate, tokens: 1 }),
    { code: 'budget_owner_group_limit' });
  assert.equal(store.get('extra'), null);
  assert.doesNotThrow(() => reserveResearchCall(store, segment, 'other-block', ['other-block'], estimate));
});

test('an oversized saved working limit cannot hide a block overrun or admit another call', t => {
  const { store, basis } = fixture(t);
  const segment = configureBudgetSegment(store, 'p', 'reconcile', 20_000_000, 800_000, 800_000);
  const id = `research-limit:${hashJson([segment.id, 'g', 'tokens'])}`;
  store.write({ id, kind: 'research-limit', expected: 0,
    value: { projectId: 'p', segment: segment.id, group: 'g', metric: 'tokens', limit: 2_000_000, ceiling: 2_000_000, decisions: [] } });
  assert.equal(workingLimit(store, segment, 'g', 'tokens', 2_000_000), 800_000);
  assert.equal(workingLimit(store, segment, 'g,fresh', 'tokens', 2_000_000), 800_000);
  const estimate = { kind: 'estimated' as const, tokens: 800_001, basis: [reference(basis)], explanation: 'fixture' };
  assert.throws(() => reserveResearchCall(store, segment, 'too-large', ['g'], estimate), { code: 'budget_owner_group_limit' });
  const reservation = reserveResearchCall(store, segment, 'overrun', ['g'], { ...estimate, tokens: 100_000 });
  store.writeMany([{ id: 'overrun', kind: 'model-call', expected: 0, value: { ...call('overrun'), status: 'succeeded', finishedAt: 2,
    usage: { inputTokens: 800_000, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } } }, ...reservation.writes], reservation.guards);
  assert.equal(budgetUsage(store, segment).measured, 800_001);
  assert.equal(budgetUsage(store, segment).remaining, 19_199_999);
  assert.throws(() => assertQuestionBudget(store, segment, ['g']), { code: 'budget_owner_group_overrun' });
  assert.throws(() => reserveResearchCall(store, segment, 'after-overrun', ['g'], { ...estimate, tokens: 1 }), { code: 'budget_owner_group_limit' });
});
