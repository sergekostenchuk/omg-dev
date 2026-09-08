import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference} from '../src/pipeline/contracts.js';
import {hashJson} from '../src/canonical.js';
import {configureReaderPilot} from '../src/discovery/reader-pilot.js';
import {priorReaderIndex} from '../src/discovery/reader-reuse.js';
import {previewResearch} from '../src/discovery/research-preview.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {workingContext} from '../src/discovery/working-context.js';
import {readPilotContext} from '../src/discovery/pilot-context.js';
import {priorEvidenceSources} from '../src/discovery/prior-evidence-summary.js';
import type {Question} from '../src/discovery/discovery.js';

function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'omg-prior-summary-')),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Prior evidence scale'});
 const command={executable:process.execPath,args:['--version']};
 const env=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 const pilot=configureReaderPilot(store,engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,maxRequestChars:300000,maxContinuationChars:100000,maxReadChars:60000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:10000000,planning:{fields:['topic'],maxRequestChars:70000,maxRounds:3}},0);
 const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'topic',kind:'design',prompt:'Resolve the current contract',risk:'Losing a required source',schema:{type:'object'}}]);
 const q=store.get<Question>(draft.value.questions[0]!)!;
 return {root,store,engine,env,pilot,draft,q};
}

test('44 source records and 321 observations fit the global 300000 request envelope without embedding the 262-entry index',async t=>{
 const f=fixture(t),sources=[];
 let count=0;
 for(let i=0;i<44;i++){
  const source=f.engine.discovery.evidence.document('p',`module-${String(i).padStart(3,'0')}-${'s'.repeat(50)}`,'ORIGINAL_BODY_SENTINEL'.repeat(250),'text/plain',0);
  sources.push(source);
  const unique=i<42?6:5,total=i<13?8:7;
  const observations=Array.from({length:total},(_,n)=>f.engine.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:(n%unique)*400,end:(n%unique)*400+200}));
  count+=observations.length;
  f.store.write({id:`reader-result:${hashJson(i)}`,kind:'reader-result',expected:0,value:{projectId:'p',question:{id:'old-question',revision:1,hash:'a'.repeat(64)},observations}});
 }
 assert.equal(count,321);
 const index=priorReaderIndex(f.store,'p',f.q.id);assert.equal(index.length,262);
 assert.ok(JSON.stringify(index).length>100000);
 const body={role:'research',stage:'om-g2',level:'R2',consumer:'compilation',dispatchMode:'planning',repositoryRoot:f.root,
  question:{id:f.q.id,...f.q.value.spec},core:{objective:'Current purpose '+ 'x'.repeat(18000),problem:'problem',actors:[],constraints:[],specificationConstraints:[],concept:{},requirements:[]},
  map:{nodes:[],contracts:[],connectors:[]},inventory:{sources:sources.map(s=>({ref:reference(s),location:s.value.origin.location,kind:s.value.origin.kind,media:'text/plain',length:s.value.content.length})),files:[],filesTruncated:false},
  catalogue:[],readings:[],directReadings:[],answers:[],priorEvidence:index,contextWorkspace:[]};
 const preview=await previewResearch(()=>researchCall(f.env.value.implementer,f.env.value,'Actual planner request',body,undefined,
  {store:f.store,draftId:f.draft.id,questionId:f.q.id,purpose:'reading-planner',pilot:f.pilot}));
 const packet=JSON.parse(preview.input).subject;
 assert.equal(preview.limit,300000);assert.ok(preview.chars<=300000);
 assert.equal(packet.priorEvidence.totalSources,44);assert.equal(packet.priorEvidence.totalObservations,262);
 assert.equal(packet.priorEvidence.sources.length,44);assert.equal(packet.priorEvidence.nextSource,null);
 assert.ok(!preview.input.includes('ORIGINAL_BODY_SENTINEL'));
 assert.ok(!preview.input.includes('/observations/5'),'Full per-observation addresses stay in the archive');
 const address=packet.priorEvidence.index;
 assert.deepEqual(readPilotContext(f.store,f.draft,address.record,address.pointer,Number.MAX_SAFE_INTEGER).value,index);
 const catalogue=packet.priorEvidence.catalogue;
 assert.equal((readPilotContext(f.store,f.draft,catalogue.record,catalogue.pointer,Number.MAX_SAFE_INTEGER).value as unknown[]).length,44);
 const continuation=workingContext(f.store,'p',f.draft.id,f.q.id,body,96000,{common:true,continuation:true});
 assert.ok(JSON.stringify(continuation).length<=96000);assert.equal(continuation.priorEvidence.totalSources,44);
 assert.equal(f.store.list('model-call').length,0);
});

test('an even larger source summary is itself addressable rather than becoming another mandatory oversized field',t=>{
 const f=fixture(t);
 const index=Array.from({length:1000},(_,i)=>({source:{id:`source:p:long-source-${i}-${'x'.repeat(80)}`,revision:1,hash:hashJson(i)},
  location:`/repository/src/module-${i}.ts`,selector:{kind:'text-range' as const,start:0,end:100},chars:100,
  original:{record:{id:`reader-result:${hashJson(i)}`,revision:1,hash:hashJson([i])},pointer:'/observations/0'}}));
 const packet=workingContext(f.store,'p',f.draft.id,f.q.id,{question:{id:f.q.id,...f.q.value.spec},priorEvidence:index,request:{current:'Do this now'}},10000,{common:true});
 assert.ok(JSON.stringify(packet).length<=10000);
 assert.equal(packet.priorEvidence.totalSources,1000);
 assert.ok(packet.priorEvidence.sources.length>0&&packet.priorEvidence.sources.length<1000);
 assert.equal(packet.priorEvidence.nextSource,packet.priorEvidence.sources.length);
 const address=packet.priorEvidence.catalogue;
 const page=readPilotContext(f.store,f.draft,address.record,address.pointer,10000,{offset:packet.priorEvidence.nextSource,limit:3});
 assert.equal((page.value as unknown[]).length,3);
 assert.deepEqual(packet.request,{current:'Do this now'});
});

test('summary merges adjacent and overlapping ranges without claiming unobserved holes',()=>{
 const source={id:'source:p:x',revision:1,hash:'a'.repeat(64)};
 const summary=priorEvidenceSources([[0,10],[5,20],[20,25],[40,50]].map(([start,end])=>({source,selector:{kind:'text-range',start:start!,end:end!}})));
 assert.deepEqual(summary[0]!.ranges,[[0,25],[40,50]]);assert.equal(summary[0]!.chars,35);
 assert.equal(summary[0]!.observations,4);
});
