import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/storage/store.js';
import {reference} from '../src/pipeline/contracts.js';
import {Discovery} from '../src/discovery/discovery.js';
import {configureResearchScope,expandResearchScope,scopeObligations,scopedQuestions,researchGapDeferred} from '../src/graph/research-scope.js';
import {carriedObligations,type ObligationPolicy} from '../src/graph/obligation-policy.js';
import {technicalProposalFindings} from '../src/graph/research-evidence.js';
import type {Graph} from '../src/graph/model.js';

function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'omg-policy-')),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const nodes=[{id:'state',code:[]},{id:'runtime',tests:[]},{id:'ui',tests:[]}];
 const layer=store.write({id:'graph-layer:p:2',kind:'graph-layer',expected:0,value:{projection:{nodes}}});
 store.write({id:'graph:p',kind:'graph',expected:0,value:{nodes}});
 const gaps=[{id:'code',target:'state',field:'code',consumer:'compilation',question:'Existing producer',requiredFor:'next' as const},
  {id:'environment',target:'runtime',field:'tests',consumer:'compilation',question:'Check exact runtime before R3',requiredFor:'next' as const},
  {id:'ui-proof',target:'ui',field:'tests',consumer:'ui',question:'Proof on the future task result',requiredFor:'next' as const}];
 const r1=store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:'p',fields:{technical:{gaps}}}});
 const phase=store.write({id:'phase:p:R1',kind:'phase',expected:0,value:{draft:reference(r1)}});
 const scope=configureResearchScope(store,{projectId:'p',layer:reference(layer),r1:reference(phase),outcome:'Recoverable projections',nodes:['state','runtime'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
  obligations:gaps.map(gap=>({gap,state:gap.id==='ui-proof'?'deferred':'active',reason:'Original approved scope',wake:gap.id==='ui-proof'?{nodes:['ui'],paths:['ui.ts'],uiRequired:true}:null}))},0);
 const policy:ObligationPolicy={version:1,sourceScope:reference(scope),assignments:gaps.map((g,i)=>({obligation:g.id,original:{record:reference(scope),pointer:`/obligations/${i}/gap`},kind:i===0?'repository-fact':i===1?'environment-confirmation':'post-implementation-proof',moment:i===0?'R2':i===1?'R3':'task-result',responsibleNode:g.target,responsibleConsumer:g.consumer,neededForR2:i===0,reason:'Approved timing for this exact obligation',returnCondition:i===0?null:i===1?'Before declaring R3 ready':'When accepting the named implementation result'}))};
 const apply=(p=policy,expected=scope.revision)=>configureResearchScope(store,{...scope.value,policy:p},expected);
 return {root,store,scope,policy,apply};
}

test('one scope revision carries every exact assignment without changing R1/L2 or original gap bytes',t=>{
 const f=fixture(t),r1=f.store.get('phase:p:R1'),layer=f.store.get('graph-layer:p:2');
 const updated=f.apply();assert.equal(updated.revision,2);
 assert.deepEqual(updated.value.obligations,f.scope.value.obligations);
 assert.deepEqual(f.store.get(f.scope.id,1),f.scope);
 assert.deepEqual(f.store.get('phase:p:R1'),r1);assert.deepEqual(f.store.get('graph-layer:p:2'),layer);
 assert.deepEqual(scopeObligations(updated.value).map(o=>o.state),['active','deferred','deferred']);
 const specs=scopedQuestions(updated.value),assigned=specs.flatMap(s=>s.obligations??[]);
 assert.deepEqual(assigned.map(o=>o.id),['code']);assert.deepEqual(assigned[0]!.assignment,f.policy.assignments[0]);
 const carried=carriedObligations(updated);
 assert.deepEqual(carried.map(c=>c.obligation),['environment','ui-proof']);
 assert.ok(carried.every(c=>c.scope.revision===2&&c.original.record.revision===1));
 assert.equal(carried[1]!.moment,'task-result');assert.equal(carried[1]!.responsibleNode,'ui');
});

test('activating nodes, paths or UI cannot rewrite the approved resolution moment',t=>{
 const f=fixture(t),updated=f.apply();
 const expanded=expandResearchScope(f.store,'p',updated.revision,'ui','Include the UI implementation',['ui.ts'],true);
 assert.deepEqual(expanded.value.policy,f.policy);
 assert.equal(scopeObligations(expanded.value).find(o=>o.gap.id==='ui-proof')!.state,'deferred');
 assert.equal(scopeObligations(expanded.value).find(o=>o.gap.id==='environment')!.state,'deferred');
 assert.equal(carriedObligations(expanded)[1]!.returnCondition,'When accepting the named implementation result');
});

test('missing, duplicated and unknown assignments cannot silently defer or drop an obligation',t=>{
 const f=fixture(t);
 for(const assignments of [f.policy.assignments.slice(1),[f.policy.assignments[0]!,f.policy.assignments[0]!,f.policy.assignments[2]!],f.policy.assignments.map((a,i)=>i===0?{...a,obligation:'invented'}:a)]){
  const policy={...f.policy,assignments};assert.throws(()=>f.apply(policy),{code:'obligation_policy_incomplete'});
 }
 assert.throws(()=>scopeObligations({...f.scope.value,policy:{...f.policy,assignments:f.policy.assignments.slice(1)}}),{code:'obligation_policy_incomplete'});
 for(const key of ['kind','moment','responsibleConsumer','neededForR2','returnCondition']){
  const policy=structuredClone(f.policy);delete (policy.assignments[0] as any)[key];
  assert.throws(()=>f.apply(policy),{code:'obligation_policy_invalid'});
 }
 assert.equal(f.store.get(f.scope.id)!.revision,1);
});

test('original source, pointer, kind and responsible consumer cannot be forged by matching a gap name',t=>{
 const f=fixture(t);
 for(const pointer of ['/obligations/1/gap','/obligations/00/gap','/obligations/0','/obligations/99/gap']){
  const policy=structuredClone(f.policy);policy.assignments[0]!.original.pointer=pointer;
  assert.throws(()=>f.apply(policy),{code:'obligation_origin_invalid'});
 }
 const foreign=structuredClone(f.policy);foreign.sourceScope.id='research-scope:other:R2';assert.throws(()=>f.apply(foreign),{code:'obligation_origin_invalid'});
 const stale=structuredClone(f.policy);stale.assignments[0]!.original.record.hash='0'.repeat(64);assert.throws(()=>f.apply(stale),{code:'obligation_origin_invalid'});
 const owner=structuredClone(f.policy);owner.assignments[0]!.responsibleConsumer='ui';assert.throws(()=>f.apply(owner),{code:'obligation_owner_invalid'});
 const unknown=structuredClone(f.policy);(unknown.assignments[0] as any).kind='automatic';assert.throws(()=>f.apply(unknown),{code:'obligation_policy_invalid'});
 const erased={...f.scope.value,policy:f.policy,obligations:f.scope.value.obligations.map(o=>({...o,state:'active' as const,wake:null}))};
 assert.throws(()=>configureResearchScope(f.store,erased,1),{code:'obligation_origin_invalid'});
});

test('current R2 knowledge cannot be postponed by its kind and deadlines cannot lose their return condition',t=>{
 const f=fixture(t);
 const moved=structuredClone(f.policy);moved.assignments[0]!.kind='environment-confirmation';moved.assignments[0]!.moment='R3';moved.assignments[0]!.returnCondition='Later';
 assert.throws(()=>f.apply(moved),{code:'obligation_deadline_invalid'});
 for(const condition of [null,' ']){
  const missing=structuredClone(f.policy);missing.assignments[1]!.returnCondition=condition;
  assert.throws(()=>f.apply(missing),{code:'obligation_deadline_invalid'});
 }
 const conservative=structuredClone(f.policy);conservative.assignments[0]!.kind='environment-confirmation';
 const saved=f.apply(conservative);assert.equal(scopeObligations(saved.value)[0]!.state,'active');
 const {policy,...withoutPolicy}=saved.value;
 assert.throws(()=>configureResearchScope(f.store,withoutPolicy,saved.revision),{code:'obligation_policy_missing'});
});

test('a competing scope revision prevents a partial overwrite and a changed policy makes the old R2 basis stale',t=>{
 const f=fixture(t),discovery=new Discovery(f.store);
 const oldDraft=discovery.create('p','om-g2','R2','compilation',scopedQuestions(f.scope.value),[reference(f.scope)],2);
 f.apply();
 assert.throws(()=>f.apply(),{code:'revision_conflict'});
 assert.ok(discovery.gate('p',reference(oldDraft)).findings.some(x=>x.code==='research_context_stale'));
 assert.equal(f.store.get(f.scope.id)!.revision,2);
});

test('an R2 assignment stays unresolved when an answer tries to cover it with a renamed gap',t=>{
 const f=fixture(t),scope=f.apply(),spec=scopedQuestions(scope.value).find(s=>s.obligations)!;
 f.store.write({id:'q',kind:'question',expected:0,value:{spec}});
 const graph={nodes:[{id:'state',code:[]},{id:'runtime',tests:[]},{id:'ui',tests:[]}],horizon:[],connectors:[],tests:[],anchors:[]} as unknown as Graph;
 const report={applicability:'applicable' as const,reason:'Report unknown',facts:[],designs:[{id:'d',decision:'proposed',benefit:'delivery',consumer:'compilation'}],
  gaps:[{...scope.value.obligations[0]!.gap,id:'renamed'}],coverage:[{obligation:'code',facts:[],designs:[],gaps:['renamed']}]};
 const findings=technicalProposalFindings(f.store,'p','R2','q',spec.field,report,[],graph,f.root);
 assert.ok(findings.some(x=>x.code==='research_gap_unresolved'&&x.target==='code'));
 assert.equal(researchGapDeferred(f.store,'p',graph,scope.value.obligations[0]!.gap),false);
 assert.equal(researchGapDeferred(f.store,'p',graph,scope.value.obligations[1]!.gap),true);
 assert.equal(researchGapDeferred(f.store,'p',graph,{...scope.value.obligations[1]!.gap,question:'Changed content'}),false);
});

test('the approved 34-obligation fixture is applied by the real policy validator as one revision',t=>{
 const matrix=JSON.parse(readFileSync('PREPARATIONS/POST-AUDIT-DISCUSSION/P1-OBLIGATION-ASSIGNMENTS.json','utf8'));
 const f=fixture(t),gaps=matrix.obligations.map((o:any)=>o.gap);
 const nodes=[...new Set(gaps.map((g:any)=>g.target))].map(id=>({id}));
 const layer=f.store.get('graph-layer:p:2')!;
 const updatedLayer=f.store.write({id:layer.id,kind:layer.kind,expected:layer.revision,value:{projection:{nodes}}});
 const r1=f.store.get('r1')!;
 const updatedR1=f.store.write({id:r1.id,kind:r1.kind,expected:r1.revision,value:{projectId:'p',fields:{technical:{gaps}}}});
 const phase=f.store.get('phase:p:R1')!;
 const updatedPhase=f.store.write({id:phase.id,kind:phase.kind,expected:phase.revision,value:{draft:reference(updatedR1)}});
 const source=configureResearchScope(f.store,{...f.scope.value,layer:reference(updatedLayer),r1:reference(updatedPhase),nodes:nodes.map(n=>n.id as string),
  obligations:matrix.obligations.map((o:any)=>({gap:o.gap,state:o.originalState,reason:o.rationale,wake:o.originalWake}))},f.scope.revision);
 const policy:ObligationPolicy={version:1,sourceScope:reference(source),assignments:matrix.obligations.map((o:any,i:number)=>({
  obligation:o.obligation,original:{record:reference(source),pointer:`/obligations/${i}/gap`},kind:o.proposedKind,moment:o.proposedMoment,
  responsibleNode:o.responsibleNode,responsibleConsumer:o.responsibleConsumer,neededForR2:o.proposedMoment==='R2',reason:o.rationale,
  returnCondition:o.returnCondition}))};
 const applied=configureResearchScope(f.store,{...source.value,policy},source.revision);
 assert.equal(applied.revision,source.revision+1);
 assert.deepEqual(applied.value.obligations,source.value.obligations);
 assert.equal(scopeObligations(applied.value).filter(o=>o.state==='active').length,27);
 const carried=carriedObligations(applied);
 assert.equal(carried.filter(o=>o.moment==='R3').length,3);assert.equal(carried.filter(o=>o.moment==='task-result').length,4);
 assert.ok(carried.every(o=>o.original.record.revision===source.revision&&o.scope.revision===applied.revision));
});
