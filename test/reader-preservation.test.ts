import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {configureReaderPilot} from '../src/discovery/reader-pilot.js';
import {readBundle} from '../src/discovery/reader.js';
import {priorReaderIndex} from '../src/discovery/reader-reuse.js';
import {readPilotContext} from '../src/discovery/pilot-context.js';
import {requireCurrentPriorContext} from '../src/discovery/research-limits.js';
import {researchReadLimit} from '../src/discovery/research-limits.js';
import {workingContext} from '../src/discovery/working-context.js';
import {reference} from '../src/pipeline/contracts.js';
import type {Question} from '../src/discovery/discovery.js';

function fixture(t:test.TestContext,maxReadChars=20000){
 const root=mkdtempSync(join(tmpdir(),'omg-reader-preserve-')),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Reader fixture'});
 const wire=join(root,'wire.ndjson'),adapter=join(root,'adapter.mjs');
 writeFileSync(adapter,`import{readFileSync,appendFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync(${JSON.stringify(wire)},JSON.stringify(c)+'\\n');
const fail=existsSync('reject-later')&&c.sources[0].visibleRange.start>0;
const selections=c.sources.map((s,i)=>({sourceIndex:i,firstLine:fail?99999:s.lines[0][0],lastLine:s.lines.at(-1)[0]}));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{selections,unresolved:['Old purpose is not a verdict for the next question']},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const command={executable:process.execPath,args:[adapter]};
 const env=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 const pilot=configureReaderPilot(store,engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,maxCalls:200,maxReportedTokens:100000,maxRequestChars:30000,maxContinuationChars:30000,maxReadChars,maxReplyChars:500,maxExtractedChars:1200},0);
 const question=()=>{
  const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'result',kind:'design',prompt:'Use the exact original',risk:'Missing evidence',schema:{type:'object'}}]);
  return {draft,q:store.get<Question>(draft.value.questions[0]!)!};
 };
 const read=(q:ReturnType<typeof question>['q'],range?:{start:number;end:number})=>readBundle(store,env.value,pilot,reference(q),'Read the original including exceptions',[{path:'source.txt',media:'text/plain',...(range?{range}:{})}]);
 const packets=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 return {root,store,engine,env,pilot,question,read,packets};
}

test('paid extraction survives a small reply budget and is delivered in bounded exact pages',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'source.txt'),'A'.repeat(6000));
 const {draft,q}=f.question();const result=await f.read(q);
 assert.ok(JSON.stringify(result.value.observations).length>f.pilot.value.maxReplyChars);
 assert.equal(f.store.list('model-call').length,1);
 assert.equal(researchReadLimit(f.store,f.pilot,q.id,'extractedChars',1,[]),1200);
 const material={kind:'reader',value:{ref:reference(result),...result.value}};
 let offset=0,materialOffset=0,joined='';
 for(let page=0;page<100;page++){
  const packet=workingContext(f.store,'p',draft.id,q.id,{question:{id:q.id,...q.value.spec},synthesisState:{offset,materialOffset},synthesisMaterials:[material],previousProposal:null},5000,{common:true,extractedChars:1200});
  assert.ok(packet.materialPage);assert.ok(JSON.stringify(packet.materialPage).length<=1200);
  joined+=packet.materialPage.text;
  if(packet.synthesisPage.complete)break;
  offset=packet.synthesisPage.end;materialOffset=packet.synthesisPage.nextMaterialOffset;
 }
 assert.deepEqual(JSON.parse(joined),material.value);
 assert.equal(f.store.list('model-call').length,1);
});

test('another question reuses full exact originals without copying old unresolved or buying extraction',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'source.txt'),'First line\nException\n');
 const first=f.question(),second=f.question();const original=await f.read(first.q);
 const reused=await f.read(second.q);
 assert.equal(f.store.list('model-call').length,1);
 assert.deepEqual(reused.value.observations,original.value.observations);
 assert.deepEqual(reused.value.unresolved,[]);
 assert.ok(reused.value.reusedFrom?.some(ref=>ref.id===original.id));
 const index=priorReaderIndex(f.store,'p',second.q.id);
 assert.equal(index.length,1);assert.ok(!Object.hasOwn(index[0]!,'value')&&!Object.hasOwn(index[0]!,'unresolved'));
 const address=index[0]!.original;
 const available=readPilotContext(f.store,second.draft,address.record,address.pointer,20000);
 assert.deepEqual(available.value,original.value.observations[0]);
 assert.throws(()=>readPilotContext(f.store,second.draft,address.record,'/unresolved',20000),{code:'context_reference_foreign'});
 assert.throws(()=>readPilotContext(f.store,{...second.draft,value:{...second.draft.value,projectId:'foreign'}},address.record,address.pointer,20000),{code:'context_reference_foreign'});
 const value=readPilotContext(f.store,second.draft,address.record,address.pointer+'/value',20000);
 writeFileSync(join(f.root,'source.txt'),'Changed after indexing');
 assert.throws(()=>requireCurrentPriorContext(f.store,second.draft,value),{code:'research_evidence_stale'});
 assert.deepEqual(priorReaderIndex(f.store,'p',second.q.id),[]);
});

test('partial prior coverage keeps enclosing conditions visible and deduplicates only the output',async t=>{
 const f=fixture(t),text='if (!allowed) throw Error("denied");\nfunction guarded() { return "value"; }\n';
 writeFileSync(join(f.root,'source.txt'),text);
 await f.read(f.question().q,{start:0,end:50});
 const result=await f.read(f.question().q);
 assert.equal(f.packets().length,2);
 const source=f.packets()[1].sources[0];
 assert.equal(source.visibleRange.start,0);
 assert.ok(source.lines.map((line:any)=>line[1]).join('').includes('if (!allowed) throw'));
 assert.ok(source.covered.some((c:any)=>c.start===0&&c.end===50&&c.readerResult&&c.pointer==='/observations/0'));
 assert.equal(result.value.observations.map(o=>o.value).join(''),text);
 assert.ok(result.value.reusedFrom?.length);
});

test('a changed source version cannot inherit earlier observation coverage',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'source.txt'),'old original');
 const old=await f.read(f.question().q);
 writeFileSync(join(f.root,'source.txt'),'new original');
 const current=await f.read(f.question().q);
 assert.equal(f.store.list('model-call').length,2);
 assert.notDeepEqual(current.value.sources,old.value.sources);
 assert.equal(current.value.observations[0]!.value,'new original');
});

test('oversized connected input splits before payment and preserves every selected source byte',async t=>{
 const f=fixture(t,1600),text='0123456789'.repeat(600);writeFileSync(join(f.root,'source.txt'),text);
 const result=await f.read(f.question().q);
 assert.ok(f.packets().length>1);
 assert.ok(f.packets().every(c=>JSON.stringify({role:c.role,purpose:c.purpose,sources:c.sources}).length<=1600));
 assert.equal(result.value.observations.map(o=>o.value).join(''),text);
 assert.ok(result.value.parts!.length>0);
});

test('a failed later chunk does not discard or repurchase the completed first chunk',async t=>{
 const f=fixture(t,1600);writeFileSync(join(f.root,'source.txt'),'Z'.repeat(6000));writeFileSync(join(f.root,'reject-later'),'fixture');
 const {q}=f.question();await assert.rejects(f.read(q),{code:'reader_selection_foreign'});
 const completed=f.store.list<any>('reader-result')[0]!;
 const firstEnd=completed.value.coverage[0].visibleRange.end;
 const before=f.packets().length;rmSync(join(f.root,'reject-later'));
 const result=await f.read(q);
 assert.ok(f.packets().slice(before).every(c=>c.sources[0].visibleRange.start>=firstEnd));
 assert.equal(result.value.observations.map(o=>o.value).join(''),'Z'.repeat(6000));
 assert.deepEqual(f.store.get(completed.id),completed);
});
