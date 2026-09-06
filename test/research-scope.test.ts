import { technicalProposalFindings } from "../src/graph/research-evidence.js";
import type { TechnicalReport } from "../src/graph/research-contracts.js";
import { readPilotContext } from "../src/discovery/pilot-context.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { configureResearchScope, expandResearchScope, researchScope, scopedQuestions, scopeObligations, type ResearchScope } from '../src/graph/research-scope.js';
import { planningForQuestion } from '../src/discovery/research-routing.js';
import { saveMapStatus, mapStatus } from '../src/graph/map-status.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ReaderPilot } from '../src/discovery/reader-pilot.js';
import type { Graph } from '../src/graph/model.js';

function fixture(t: test.TestContext) {
  const root=mkdtempSync(join(tmpdir(),'omg-scope-')),store=new Store(join(root,'db.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const graph={nodes:[{id:'n-state'},{id:'n-ui'},{id:'n-other'}],horizon:[]} as unknown as Graph;
  const layer=store.write({id:'graph-layer:p:2',kind:'graph-layer',expected:0,value:{projection:graph}});
  store.write({id:'graph:p',kind:'graph',expected:0,value:graph});
  const gaps=[{id:'g-state',target:'n-state',field:'code',consumer:'n-state',question:'exact state',requiredFor:'next' as const},
    {id:'actors-g5',target:'n-ui',field:'tests',consumer:'n-ui',question:'QuestionPanel',requiredFor:'next' as const},
    {id:'g-state-second',target:'n-state',field:'code',consumer:'n-state',question:'second independent state obligation',requiredFor:'next' as const}];
  const r1=store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:'p',fields:{technical:{gaps}}}});
  store.write({id:'phase:p:R1',kind:'phase',expected:0,value:{draft:reference(r1)}});
  const value:ResearchScope={projectId:'p',layer:reference(layer),r1:reference(store.get('phase:p:R1')!),outcome:'readable projection',nodes:['n-state'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
    obligations:gaps.map(gap=>({gap,state:gap.id==='actors-g5'?'deferred':'active',reason:'explicit scope',wake:gap.id==='actors-g5'?{nodes:['n-ui'],paths:['ui/app.tsx'],uiRequired:true}:null}))};
  return {store,value,root};
}

test('scope preserves every gap; absence, foreign L2 and missing wake conditions fail closed',t=>{
  const {store,value}=fixture(t);
  assert.throws(()=>configureResearchScope(store,{...value,obligations:[]},0),{code:'scope_gap_missing'});
  assert.throws(()=>configureResearchScope(store,{...value,layer:{...value.layer,id:'graph-layer:foreign:2'}},0),{code:'scope_basis_foreign'});
  assert.throws(()=>configureResearchScope(store,{...value,obligations:value.obligations.map(o=>({...o,wake:null}))},0),{code:'scope_deferral_invalid'});
  const scope=configureResearchScope(store,value,0);
  assert.equal(scopedQuestions(scope.value).length,5);
  const expanded=expandResearchScope(store,'p',scope.revision,'n-ui','projection now needs a UI entry');
  assert.equal(scopedQuestions(expanded.value).length,6);
  assert.equal(scopeObligations(expanded.value).find(o=>o.gap.id==='actors-g5')!.state,'active');
  assert.equal(store.get<ResearchScope>(scope.id,1)!.value.obligations[1]!.state,'deferred');
});

test('R2 routing accepts generated contracts, refuses schema/target masquerades and missing settings',t=>{
  const {store,value}=fixture(t);
  configureResearchScope(store,value,0);
  const specs=scopedQuestions(value);
  const pilot={id:'pilot',kind:'reader-pilot',revision:1,hash:'a'.repeat(64),value:{planning:{fields:['old-R1'],maxRequestChars:70000,maxRounds:5}}} as unknown as import('../src/storage/store.js').Revision<ReaderPilot>;
  const draft=store.write<DiscoveryDraft>({id:'r2',kind:'discovery-draft',expected:0,value:{projectId:'p',stage:'om-g2',level:'R2',consumer:'compilation',contractVersion:2,questions:['q'],inputs:[]}});
  for(const spec of specs) {
    const previous=store.get('q');
    const question=store.write<Question>({id:'q',kind:'question',expected:previous?.revision??0,value:{projectId:'p',draftId:'r2',stage:'om-g2',level:'R2',consumer:'compilation',spec}});
    assert.equal(planningForQuestion(store,draft,question,pilot),pilot.value.planning);
    assert.throws(()=>planningForQuestion(store,draft,{...question,value:{...question.value,spec:{...spec,schema:{}}}},pilot),{code:'research_contract_mismatch'});
    assert.throws(()=>planningForQuestion(store,draft,{...question,value:{...question.value,spec:{...spec,prompt:'forged'}}},pilot),{code:'research_contract_mismatch'});
    assert.throws(()=>planningForQuestion(store,draft,question,{...pilot,value:{} as ReaderPilot}),{code:'planning_settings_missing'});
  }
});

test('map implementation delta has source evidence and leaves accepted layer bytes intact',t=>{
  const {store,root}=fixture(t);
  writeFileSync(join(root,'app.tsx'),'export function App() {}');
  const before=store.get('graph-layer:p:2')!, graph=store.get('graph:p')!;
  const delta={projectId:'p',base:reference(graph),actor:'owner',nodes:[{id:'n-ui',status:'existing' as const,explanation:'Existing UI with deferred tests',code:[{path:'app.tsx',access:'read' as const,status:'existing' as const}]}]};
  assert.throws(()=>saveMapStatus(store,{...delta,nodes:[{...delta.nodes[0]!,code:[]}]},0,root),{code:'map_status_invalid'});
  saveMapStatus(store,delta,0,root);
  assert.equal(mapStatus(store,'p')!.current,true);
  assert.deepEqual(store.get('graph-layer:p:2'),before);
  assert.deepEqual(store.get('graph:p'),graph);
  store.write({id:graph.id,kind:graph.kind,expected:graph.revision,value:{...graph.value as object,changed:true}});
  assert.equal(mapStatus(store,'p')!.current,false);
});

test('compact scope index retains readable original gap text at its exact SQLite reference',t=>{
  const {store,value}=fixture(t);
  const scope=configureResearchScope(store,value,0);
  const draft=store.write<DiscoveryDraft>({id:'bound-r2',kind:'discovery-draft',expected:0,value:{projectId:'p',inputs:[reference(scope)]}});
  const read=readPilotContext(store,draft,reference(scope),'/obligations/1/gap/question',10000);
  assert.equal(read.value,'QuestionPanel');
});

test('R1 replacement invalidates the scope even when L2 is unchanged',t=>{
  const {store,value}=fixture(t);configureResearchScope(store,value,0);
  const phase=store.get('phase:p:R1')!;
  store.write({id:phase.id,kind:phase.kind,expected:phase.revision,value:phase.value});
  assert.throws(()=>researchScope(store,'p'),{code:'scope_basis_foreign'});
});

test('every grouped obligation needs its own valid resolution, not applicability alone',t=>{
  const {store,value,root}=fixture(t);configureResearchScope(store,value,0);
  const spec=scopedQuestions(value).find(s=>s.obligations)!;
  store.write({id:'coverage-q',kind:'question',expected:0,value:{spec}});
  const graph=store.get<Graph>('graph:p')!.value;
  const report:TechnicalReport={applicability:'applicable',reason:'test',facts:[],designs:[{id:'d',decision:'state contract',benefit:'result',consumer:'n-state'}],gaps:[]};
  const check=(r:TechnicalReport)=>technicalProposalFindings(store,'p','R2','coverage-q',spec.field,r,[],graph,root);
  assert.ok(check(report).some(f=>f.code==='research_group_coverage_missing'));
  const covered={...report,coverage:[{obligation:'g-state',facts:[],designs:['d'],gaps:[]},{obligation:'g-state-second',facts:[],designs:['d'],gaps:[]}]};
  assert.ok(!check(covered).some(f=>f.code==='research_group_coverage_missing'));
  assert.ok(check({...covered,coverage:[{...covered.coverage[0]!,designs:['invented']}]}).some(f=>f.code==='research_group_coverage_missing'));
  assert.ok(check({...covered,coverage:[{...covered.coverage[0]!,obligation:'foreign'}]}).some(f=>f.code==='research_group_coverage_missing'));
});
