import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, type Write} from '../src/storage/store.js';
import {EngineError} from '../src/errors.js';
import {ProductEngine} from '../src/product/engine.js';
import {configureReaderPilot} from '../src/discovery/reader-pilot.js';
import {readBundle,readReaderResultAt,resumeReadBundleIntent,numberedSource,readerObservations} from '../src/discovery/reader.js';
import {ResearchSources} from '../src/discovery/research-sources.js';
import {priorReaderIndex} from '../src/discovery/reader-reuse.js';
import {readPilotContext} from '../src/discovery/pilot-context.js';
import {requireCurrentPriorContext} from '../src/discovery/research-limits.js';
import {researchReadLimit} from '../src/discovery/research-limits.js';
import {workingContext} from '../src/discovery/working-context.js';
import {reference} from '../src/pipeline/contracts.js';
import {hashJson} from '../src/canonical.js';
import type {ReaderResult} from '../src/discovery/reader.js';
import type {Source} from '../src/evidence/evidence.js';
import type {Question} from '../src/discovery/discovery.js';

function fixture(t:test.TestContext,maxRequestChars=30000){
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
 const pilot=configureReaderPilot(store,engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,maxCalls:200,maxReportedTokens:100000,maxRequestChars,maxContinuationChars:30000,maxReadChars:20000,maxReplyChars:500,maxExtractedChars:1200},0);
 const question=()=>{
  const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'result',kind:'design',prompt:'Use the exact original',risk:'Missing evidence',schema:{type:'object'}}]);
  return {draft,q:store.get<Question>(draft.value.questions[0]!)!};
 };
 const read=(q:ReturnType<typeof question>['q'],range?:{start:number;end:number})=>readBundle(store,env.value,pilot,reference(q),'Read the original including exceptions',[{path:'source.txt',media:'text/plain',...(range?{range}:{})}]);
 const packets=()=>readFileSync(wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 return {root,store,engine,env,pilot,question,read,packets};
}

test('paid extraction is accepted despite a former reply discipline and is delivered in bounded exact pages',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'source.txt'),'A'.repeat(6000));
 const {draft,q}=f.question();const result=await f.read(q);
 assert.ok(JSON.stringify(result.value.observations).length>f.pilot.value.maxReplyChars);
 assert.equal(f.store.list('model-call').length,1);
 assert.equal(researchReadLimit(f.store,f.pilot,q.id,'extractedChars',1,[]),30000);
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

test('historical reused output cannot create uncovered bytes from its source',async t=>{
 const f=fixture(t),text='first\nsecond\n';writeFileSync(join(f.root,'source.txt'),text);
 const {q}=f.question();
 const prior=await f.read(q,{start:0,end:6});
 const source=f.store.get<Source>(prior.value.sources[0]!.id,prior.value.sources[0]!.revision)!;
 const supplied=[numberedSource(source)];
 const projected=readerObservations(f.store,'p',supplied,
  {selections:[{sourceIndex:0,firstLine:1,lastLine:2}],unresolved:[]},
  Number.MAX_SAFE_INTEGER,prior.value.observations).observations;
 const value:ReaderResult={...prior.value,contract:'reader-result/v2',producer:'reused',
  sources:[reference(source)],coverage:supplied.map(({lines:_lines,...entry})=>entry),
  observations:projected,unresolved:[],reusedFrom:[reference(prior)]};
 delete value.intent;
 const forged=f.store.write<ReaderResult>({id:`reader-result:v2:${hashJson(value)}`,
  kind:'reader-result',expected:0,value});
 const db=new Store(join(f.root,'db.sqlite'));t.after(()=>db.close());
 assert.throws(()=>readReaderResultAt(db,'p',reference(forged)),{code:'reader_result_invalid'});
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
 const f=fixture(t,30000),text='0123456789'.repeat(6000);writeFileSync(join(f.root,'source.txt'),text);
 const result=await f.read(f.question().q);
 assert.ok(f.packets().length>1);
 assert.ok(f.packets().every(c=>JSON.stringify({role:c.role,purpose:c.purpose,sources:c.sources}).length<=30000));
 assert.equal(result.value.observations.map(o=>o.value).join(''),text);
 assert.ok(result.value.parts!.length>0);
});

test('a completed split repeats its exact result after the current file changes',async t=>{
 const f=fixture(t,30000),text='0123456789'.repeat(6000);
 writeFileSync(join(f.root,'source.txt'),text);
 const {q}=f.question(), result=await f.read(q);
 assert.equal(result.value.producer,'combined');
 const before=f.store.list('model-call').length;
 writeFileSync(join(f.root,'source.txt'),'Changed after complete split');
 const db=new Store(join(f.root,'db.sqlite'));t.after(()=>db.close());
 assert.deepEqual(readReaderResultAt(db,'p',reference(result)),result);
 const repeated=await readBundle(db,f.env.value,f.pilot,reference(q),
  'Read the original including exceptions',[{path:'source.txt',media:'text/plain'}]);
 assert.deepEqual(repeated,result);
 const child=db.list<any>('research-consumer-intent')[0]!;
 assert.deepEqual(await resumeReadBundleIntent(db,reference(child),f.env.value,f.pilot,undefined,[]),result);
 assert.equal(db.list('model-call').length,before);
});

test('a completed split with a reused half returns its historical result before current admission',async t=>{
 const f=fixture(t,30000),text='0123456789'.repeat(6000);
 writeFileSync(join(f.root,'source.txt'),text);
 const first=f.question();
 await f.read(first.q,{start:0,end:30000});
 const second=f.question();
 const result=await f.read(second.q);
 assert.equal(result.value.producer,'combined');
 const reused=f.store.get<ReaderResult>(result.value.parts![0]!.id,result.value.parts![0]!.revision)!;
 assert.equal(reused.value.producer,'reused');
 const before=f.store.list('model-call').length;
 writeFileSync(join(f.root,'source.txt'),'Changed after the complete mixed split');
 const db=new Store(join(f.root,'db.sqlite'));t.after(()=>db.close());
 const inputs=[{path:'source.txt',media:'text/plain' as const}];
 const repeated=await readBundle(db,f.env.value,f.pilot,reference(second.q),
  'Read the original including exceptions',inputs);
 assert.deepEqual(repeated,result);
 const child=db.list<any>('research-consumer-intent').find(intent=>intent.value.question.id===second.q.id)!;
 assert.deepEqual(await resumeReadBundleIntent(db,reference(child),f.env.value,f.pilot,undefined,[]),result);
 assert.equal(db.list('model-call').length,before);
});

for (const priorSize of [15000, 30000]) test(`a borrowed ${priorSize === 15000 ? 'paid leaf' : 'combined subtree'} retains its original paths in a new root`, async t => {
 const f=fixture(t,30000), text='0123456789'.repeat(6000);
 writeFileSync(join(f.root,'source.txt'),text);
 const {q}=f.question(), prior=await f.read(q,{start:0,end:priorSize});
 assert.equal(prior.value.producer,priorSize===15000?'paid':'combined');
 const before=f.store.list('model-call').length;
 const result=await f.read(q);
 const exactParts=(ref:ReturnType<typeof reference>):string[]=>{
  const r=readReaderResultAt(f.store,'p',ref);
  return [r.id,...(r.value.parts??[]).flatMap(exactParts)];
 };
 assert.ok(exactParts(reference(result)).includes(prior.id), 'the original R is borrowed directly, without changing its producer');
 assert.equal(result.value.observations.map(row=>row.value).join(''),text);
 assert.equal(f.store.list('model-call').length,4, 'only the missing source windows are paid');
 assert.ok(f.store.list('model-call').length>before);
 const calls=f.store.list('model-call'), intents=f.store.list<any>('research-consumer-intent')
  .filter(intent=>!intent.value.cursor.rootInputs[0].range);
 writeFileSync(join(f.root,'source.txt'),'Today’s file differs');
 const db=new Store(join(f.root,'db.sqlite'));t.after(()=>db.close());
 assert.deepEqual(await readBundle(db,f.env.value,f.pilot,reference(q),'Read the original including exceptions',
  [{path:'source.txt',media:'text/plain'}]),result);
 for(const intent of [intents[0]!,intents.at(-1)!])
  assert.deepEqual(await resumeReadBundleIntent(db,reference(intent),f.env.value,f.pilot,undefined,[]),result);
 assert.deepEqual(db.list('model-call'),calls);
});

for (const borrowed of [false,true]) test(`all completed parts rebuild a missing parent historically (borrowed=${borrowed})`, async t=>{
 const f=fixture(t,30000),text='Z'.repeat(60000);writeFileSync(join(f.root,'source.txt'),text);
 const {q}=f.question();if(borrowed) await f.read(q,{start:0,end:30000});
 const original=f.store.writeMany.bind(f.store);let crashed=false,expected:ReaderResult|undefined;
 f.store.writeMany=((writes:Write[],guards=[])=>{
  const parent=writes.find(write=>write.kind==='reader-result' && (write.value as ReaderResult).producer==='combined'
   && (write.value as ReaderResult).coverage[0]?.visibleRange.end===60000
   && (write.value as ReaderResult).coverage[0]?.visibleRange.start===0);
  if(!crashed&&parent){crashed=true;expected=parent.value as ReaderResult;throw new EngineError('fixture_parent_crash','Parts durable; parent absent');}
  return original(writes,guards);
 }) as typeof f.store.writeMany;
 await assert.rejects(f.read(q),{code:'fixture_parent_crash'});f.store.writeMany=original;
 assert.ok(expected);const calls=f.store.list('model-call');assert.equal(calls.length,4);
 writeFileSync(join(f.root,'source.txt'),'Changed after complete children');
 const db=new Store(join(f.root,'db.sqlite'));t.after(()=>db.close());
 const result=await readBundle(db,f.env.value,f.pilot,reference(q),'Read the original including exceptions',
  [{path:'source.txt',media:'text/plain'}]);
 assert.deepEqual(result.value,expected);
 const reopened=new Store(join(f.root,'db.sqlite'));t.after(()=>reopened.close());
 assert.deepEqual(readReaderResultAt(reopened,'p',reference(result)),result);
 const child=reopened.list<any>('research-consumer-intent').find(item=>!item.value.cursor.rootInputs[0].range)!;
 assert.deepEqual(await resumeReadBundleIntent(reopened,reference(child),f.env.value,f.pilot,undefined,[]),result);
 assert.deepEqual(reopened.list('model-call'),calls);
});

test('a paid invalid later chunk preserves the first result and cannot be repurchased by retry',async t=>{
 const f=fixture(t,30000);writeFileSync(join(f.root,'source.txt'),'Z'.repeat(60000));writeFileSync(join(f.root,'reject-later'),'fixture');
 const {q}=f.question();await assert.rejects(f.read(q),{code:'reader_selection_foreign'});
 const completed=f.store.list<any>('reader-result')[0]!;
 const firstEnd=completed.value.coverage[0].visibleRange.end;
 const before=f.packets().length,calls=f.store.list('model-call'),responses=f.store.list('model-response');
 assert.ok(before>1);assert.ok(f.packets().at(-1).sources[0].visibleRange.start>=firstEnd);
 rmSync(join(f.root,'reject-later'));
 const db=new Store(join(f.root,'db.sqlite'));t.after(()=>db.close());
 await assert.rejects(readBundle(db,f.env.value,f.pilot,reference(q),'Read the original including exceptions',
  [{path:'source.txt',media:'text/plain'}]),{code:'reader_selection_foreign'});
 writeFileSync(join(f.root,'source.txt'),'The current file is no longer the refused paid source');
 await assert.rejects(readBundle(db,f.env.value,f.pilot,reference(q),'Read the original including exceptions',
  [{path:'source.txt',media:'text/plain'}]),{code:'reader_selection_foreign'});
 assert.equal(f.packets().length,before);
 assert.deepEqual(db.list('model-call'),calls);assert.deepEqual(db.list('model-response'),responses);
 assert.deepEqual(db.get(completed.id),completed);
 writeFileSync(join(f.root,'source.txt'),'A changed source and exception\n');
 const newSource=new ResearchSources(db,'p',f.root).read('source.txt','text/plain');
 const newWork=await readBundle(db,f.env.value,f.pilot,reference(q),
  'Read the original including exceptions',[{source:reference(newSource)}]);
 assert.equal(newWork.value.observations.map(o=>o.value).join(''),'A changed source and exception\n');
 assert.equal(db.list('model-call').length,calls.length+1,
  'an explicitly selected new source is a new logical task, not a retry of the refused child');
});

test('a new reused result guards current environment and the absence of its own paid claim',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'source.txt'),'Original for reuse\n');
 await f.read(f.question().q);const next=f.question(),calls=f.store.list('model-call');
 const competitor=new Store(join(f.root,'db.sqlite'));t.after(()=>competitor.close());
 const original=f.store.writeMany.bind(f.store);let raced=false;
 f.store.writeMany=((writes:Write[],guards=[])=>{
  if(!raced&&writes.some(write=>write.kind==='reader-result'&&(write.value as ReaderResult).producer==='reused')){
   raced=true;assert.ok(guards.some(guard=>'absent'in guard&&guard.id.startsWith('research-consumer-intent:')));
   new ProductEngine(competitor).environments.configure('p',{...f.env.value},f.env.revision);
  }
  return original(writes,guards);
 }) as typeof f.store.writeMany;
 await assert.rejects(f.read(next.q),{code:'input_stale'});f.store.writeMany=original;
 assert.equal(raced,true);assert.equal(f.store.list('reader-result').length,1);
 const result=await f.read(next.q);assert.equal(result.value.producer,'reused');
 assert.deepEqual(f.store.list('model-call'),calls);
});
