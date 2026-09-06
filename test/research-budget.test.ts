import { estimateCliCall } from "../src/adapters/codex-estimate.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { hashJson } from '../src/canonical.js';
import { configureBudgetSegment, reserveResearchCall, budgetUsage, raiseWorkingLimit, workingLimit, accommodateMetric, budgetGroups, type Optimization } from '../src/runtime/research-budget.js';
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
  return {store,segment,basis};
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
  const changed=raiseWorkingLimit(store,segment,'g','tokens',700000,decision);
  assert.equal(changed.value.limit,880000);
});

test('foreign/missing estimates and loss of constraints are typed refusals',t=>{
  const {store,segment,basis}=fixture(t);
  assert.throws(()=>reserveResearchCall(store,segment,'c',['g'],{kind:'estimated',tokens:0,basis:[],explanation:''}),{code:'budget_estimate_missing'});
  const decision: Optimization={reason:'need',progress:'p',required:800,obligations:['exception','consumer'],forecast:'required work',basis:[reference(basis)],
    options:[{method:'drop-consumer',saved:50,decision:'accept',quality:'claim only',preserved:['exception']}]};
  assert.throws(()=>raiseWorkingLimit(store,segment,'g','tokens',700,decision),{code:'budget_quality_loss'});
  decision.options[0]!.decision='reject';
  assert.equal(raiseWorkingLimit(store,segment,'g','tokens',700,decision).value.limit,880);
  assert.throws(()=>raiseWorkingLimit(store,segment,'g','tokens',700,{...decision,required:900}),{code:'budget_no_progress'});
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
  const draft=store.write<import('../src/discovery/discovery.js').DiscoveryDraft>({id:'metric-draft',kind:'discovery-draft',expected:0,value:{projectId:'p',questions:['q']}});
  assert.throws(()=>accommodateMetric(store,segment,'g','requestChars',70,80,draft,'q',[reference(basis)],'measured mandatory size',85),{code:'budget_transport_limit'});
  assert.equal(accommodateMetric(store,segment,'g','requestChars',70,80,draft,'q',[reference(basis)],'measured mandatory size',100),88);
  assert.equal(workingLimit(store,segment,'g,new-target','requestChars',70),88);
});
