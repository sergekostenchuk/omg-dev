import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {previewResearch} from '../src/discovery/research-preview.js';
import {canonical,digest,hashJson} from '../src/canonical.js';
import type {Question} from '../src/discovery/discovery.js';
import {configureReaderPilot} from '../src/discovery/reader-pilot.js';

function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'omg-preview-')),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Preview'});
 const wire=join(root,'wire.json'),adapter=join(root,'adapter.mjs');
 writeFileSync(adapter,`import{readFileSync,writeFileSync}from'node:fs';const raw=readFileSync(0,'utf8');writeFileSync(${JSON.stringify(wire)},raw);const r=JSON.parse(raw);console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'fixture'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const command={executable:process.execPath,args:[adapter]};
 const environment=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'result',kind:'design',prompt:'Read the exact input',risk:'Missing input',schema:{type:'object'}}]);
 const question=store.get<Question>(draft.value.questions[0]!)!;
 const context={role:'research',question:{id:question.id,...question.value.spec},requiredOriginal:'Exact boundary and exception'};
 const audit={store,draftId:draft.id,questionId:question.id,purpose:'analyst'};
 const call=(value:unknown=context)=>researchCall(environment.value.implementer,environment.value,'Test exact envelope',value,undefined,audit);
 return {root,store,engine,environment,draft,question,context,audit,call,wire};
}

test('preview captures the same actual envelope without provider, usage, reservation or foundation delivery',async t=>{
 const f=fixture(t),captured=await previewResearch(()=>f.call());
 assert.equal(captured.chars,captured.input.length);assert.equal(captured.bytes,Buffer.byteLength(captured.input));
 assert.equal(captured.hash,digest(captured.input));assert.ok(captured.chars<=captured.limit);
 assert.equal(captured.question,f.question.id);assert.equal(captured.draft,f.draft.id);
 assert.equal(f.store.list('model-call').length,0);assert.equal(f.store.list('model-request').length,0);
 assert.equal(f.store.list('research-budget-ledger').length,0);assert.equal(f.store.list('question-dispatch').length,0);
 assert.equal(existsSync(f.wire),false);
 await f.call();
 const actual=JSON.parse(readFileSync(f.wire,'utf8')),preview=JSON.parse(captured.input);
 assert.deepEqual({...preview,requestId:actual.requestId},actual);
 assert.equal(actual.subject.continuation.kind,'initial');assert.equal(f.store.list('model-call').length,1);
});

test('catching a preview stop does not permit a later call inside the preview callback',async t=>{
 const f=fixture(t);
 const preview=await previewResearch(async()=>{for(let i=0;i<2;i++)try{await f.call({...f.context,attempt:i});}catch{/* Caller may handle a pause. */}});
 assert.equal(JSON.parse(preview.input).subject.attempt,0);
 assert.equal(f.store.list('model-call').length,0);assert.equal(existsSync(f.wire),false);
});

test('unbound and oversized previews fail closed without invoking the provider',async t=>{
 const f=fixture(t);
 await assert.rejects(previewResearch(()=>researchCall(f.environment.value.implementer,f.environment.value,'Unbound',{},undefined)),{code:'research_preview_unbound'});
 await assert.rejects(previewResearch(()=>f.call({...f.context,requiredOriginal:'X'.repeat(400000)})),{code:'pilot_core_limit'});
 assert.equal(f.store.list('model-call').length,0);assert.equal(existsSync(f.wire),false);
});

test('the real researcher path exposes its first request through preview without accepting an answer',async t=>{
 const f=fixture(t),captured=await previewResearch(()=>f.engine.researcher.run('p',f.draft.id,1));
 assert.equal(captured.question,f.question.id);
 assert.equal(f.store.list('model-call').length,0);
 assert.equal(f.store.get<Question>(f.question.id)!.value.status,'open');
 assert.equal(f.store.list<any>('research-run')[0]!.value.pauseCode,'research_preview_ready');
 assert.equal(existsSync(f.wire),false);
});

test('the global ReaderPilot request limit applies to initial and continuation requests while legacy planner and continuation limits are inert',async t=>{
 const f=fixture(t),command=f.environment.value.implementer.command;
 const settings={experimental:true as const,active:true,stopAfter:'L2' as const,reader:{actor:'reader',model:'fixture',effort:'high' as const,speed:'inherited' as const,command},
  agentCommand:command,maxRequestChars:300000,maxContinuationChars:100000,maxReadChars:60000,maxReplyChars:10000,maxCalls:100,maxReportedTokens:20000000,
  planning:{fields:['result'],maxRequestChars:120000,maxRounds:5}};
 const pilot=configureReaderPilot(f.store,f.engine.environments,'p',settings,0);
 const context={...f.context,request:{text:'X'.repeat(110000)}};
 const call=(selected=pilot,value=context)=>researchCall(f.environment.value.implementer,f.environment.value,'Planner limit',value,undefined,
  {...f.audit,purpose:'reading-planner',pilot:selected});
 await call();
 const first=f.store.list<any>('model-call')[0]!;
 assert.equal(first.value.packet.maxChars,300000);assert.ok(first.value.request.chars>100000);
 const preview=await previewResearch(()=>call());
 assert.equal(preview.limit,300000);assert.ok(preview.chars>100000&&preview.chars<=300000);
 assert.equal(JSON.parse(preview.input).subject.continuation.kind,'continuation');
 const oversizedRequest={text:'X'.repeat(350000)};
 const bounded=await previewResearch(()=>call(pilot,{...f.context,request:oversizedRequest}));
 const boundedSubject=JSON.parse(bounded.input).subject;
 const delivery=boundedSubject.materialDelivery[0];
 assert.ok(bounded.chars<=bounded.limit);
 assert.equal(boundedSubject.request,undefined,'The complete original is not duplicated in the packet');
 assert.equal(delivery.contract,'research-delivery/v1');
 assert.equal(delivery.original.pointer,'/body/request');
 assert.equal(delivery.original.valueHash,hashJson(oversizedRequest));
 assert.equal(delivery.text,canonical(oversizedRequest).slice(0,delivery.served.end));
 assert.ok(delivery.served.end>0&&delivery.served.next>0);
 assert.equal(delivery.served.total,canonical(oversizedRequest).length);
 const physical=configureReaderPilot(f.store,f.engine.environments,'p',{...settings,physicalLimits:{maxRequestChars:100000,maxReplyChars:10000,basis:'Fixture transport capacity'}},pilot.revision);
 await assert.rejects(previewResearch(()=>call(physical)),{code:'budget_transport_limit'});
 assert.equal(f.store.list('model-call').length,1);
});
