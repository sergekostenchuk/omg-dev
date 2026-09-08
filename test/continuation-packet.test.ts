import { Evidence } from "../src/evidence/evidence.js";
import { layerDesignSpec } from "../src/graph/layer-design.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import type { Environment } from '../src/runtime/environment.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import { hashJson } from '../src/canonical.js';
import { reference } from '../src/pipeline/contracts.js';
import { continuationState, continuationDispatch, replaceFoundationCopies } from '../src/discovery/continuation-packet.js';

function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'omg-continuations-')),path=join(root,'state.sqlite');
 const store=new Store(path),log=join(root,'wire.ndjson'),adapter=join(root,'adapter.mjs');
 writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'fixture'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const role={actor:'fixture',model:'fixture',effort:'high' as const,command:{executable:process.execPath,args:[adapter]}};
 const env:Environment={projectId:'p',workspace:root,implementer:role,reviewer:{...role,actor:'reviewer'},fullCheck:role.command,timeoutMs:5000};
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {store,root,path,log,role,env};
}
function question(store:Store,stage:'discovery'|'om-g2',level:'R0'|'R1'|'R2',suffix:string){
 const id='q-'+suffix,draftId='d-'+suffix;
 const spec=suffix==='L3'?layerDesignSpec(3):{field:'topic',kind:'design',prompt:'Resolve the selected topic and preserve exceptions.',risk:'missing exception',schema:{type:'object'}};
 const draft=store.write<DiscoveryDraft>({id:draftId,kind:'discovery-draft',expected:0,value:{projectId:'p',stage,level,consumer:'compilation',questions:[id],fields:{topic:null},inputs:[]}});
 const q=store.write<Question>({id,kind:'question',expected:0,value:{projectId:'p',draftId,stage,level,consumer:'compilation',spec,status:'open',beforeHash:hashJson(null),answer:null}});
 return {draft,q};
}
function body(q:ReturnType<typeof question>['q'],root:string,purpose:string){
 return {role:purpose==='reader'?'reader':purpose==='assessor'?'assess-answer':'research',stage:q.value.stage,level:q.value.level,consumer:'compilation',
  ...(purpose==='reading-planner'?{dispatchMode:'planning'}:{}),repositoryRoot:root,question:{id:q.id,...q.value.spec},
  core:{objective:'FOUNDATION_SENTINEL '+ 'x'.repeat(12000),problem:'problem',actors:[],constraints:[],specificationConstraints:[],concept:{},requirements:[]},
  map:{nodes:[],contracts:[],connectors:[]},inventory:{sources:[],files:[],filesTruncated:false},catalogue:[],readings:[],directReadings:[],answers:[],
  ...(purpose==='reader'?{purpose:'Read the current piece',sources:[{sourceIndex:0,lines:[[1,'CURRENT PIECE']]}]}:{}),
  ...(purpose==='assessor'?{value:{claim:'CANDIDATE_SENTINEL '+ 'v'.repeat(5000)}}:{})};
}

test('actual dry envelopes carry foundation once per question/role in R0/R1/R2/L3, including corrections and cold reopen',async t=>{
 const f=fixture(t);
 for(const [stage,level,suffix] of [['discovery','R0','R0'],['om-g2','R1','R1'],['om-g2','R2','R2'],['om-g2','R2','L3']] as const){
  const {draft,q}=question(f.store,stage,level,suffix);
  for(const purpose of ['reading-planner','reader','analyst','assessor','escalation-assessor']){
   const first=body(q,f.root,purpose);
   await researchCall(f.role,f.env,'PROMPT_SENTINEL',first,undefined,{store:f.store,draftId:draft.id,questionId:q.id,purpose});
   const continuation={...first,focus:{piece:'CURRENT PIECE'},history:[{error:'Correction',feedback:{renamed:first.core,serialized:JSON.stringify(first.core)}}],
    checkpoints:[{proposal:{finding:'Saved conclusion',citations:[]},observations:[{text:'OLD EVIDENCE '.repeat(1000)}]}]};
   const reopened=new Store(f.path);
   try{await researchCall(f.role,f.env,'PROMPT_SENTINEL',continuation,undefined,{store:reopened,draftId:draft.id,questionId:q.id,purpose});}finally{reopened.close();}
  }
 }
 const sent=readFileSync(f.log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(sent.length,40);
 const groups=new Map<string,any[]>();
 for(const wire of sent){const key=wire.subject.continuation.question+':'+wire.subject.continuation.role;groups.set(key,[...(groups.get(key)??[]),wire]);}
 for(const wires of groups.values()){
  assert.equal(wires.filter(w=>JSON.stringify(w).includes('FOUNDATION_SENTINEL')).length,1);
  assert.equal(wires.filter(w=>w.prompt.includes('PROMPT_SENTINEL')).length,1);
  const next=wires[1];assert.equal(next.subject.continuation.kind,'continuation');
  assert.ok(JSON.stringify(next).length<=100000);
  assert.ok(!Object.hasOwn(next.subject,'core'));assert.ok(!Object.hasOwn(next.subject,'map'));
  assert.ok(!Object.hasOwn(next.subject,'inventory'));assert.ok(next.subject.conclusions);
  if(next.subject.role==='assess-answer')assert.ok(!JSON.stringify(next).includes('CANDIDATE_SENTINEL'));
 }
});

test('missing/foreign question and competing bootstrap reservations cannot bypass the shared packer',t=>{
 const f=fixture(t),{draft,q}=question(f.store,'discovery','R0','race');
 assert.throws(()=>continuationState(f.store,'foreign',draft.id,q.id,'reader','a'),{code:'continuation_question_missing'});
 const a=continuationState(f.store,'p',draft.id,q.id,'reader','a'),b=continuationState(f.store,'p',draft.id,q.id,'reader','a');
 const left=continuationDispatch(a,"model-call:left"),right=continuationDispatch(b,"model-call:right");
 f.store.writeMany(left.writes,left.guards);
 assert.throws(()=>f.store.writeMany(right.writes,right.guards),{code:'revision_conflict'});
});

test('an oversized mandatory continuation stops before the adapter and cannot grow its ceiling',async t=>{
 const f=fixture(t),{draft,q}=question(f.store,'discovery','R0','oversize');
 await researchCall(f.role,f.env,'fixture',body(q,f.root,'analyst'),undefined,{store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'});
 await assert.rejects(researchCall(f.role,f.env,'fixture',{...body(q,f.root,'analyst'),request:{piece:'x'.repeat(350000)}},undefined,
  {store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'}));
 assert.equal(readFileSync(f.log,'utf8').trim().split('\n').length,1);
 assert.equal(f.store.list('research-limit').length,0);
});

test('oversized saved material is sent in bounded exact fragments without repeating the foundation',async t=>{
 const f=fixture(t),{draft,q}=question(f.store,'discovery','R0','fragments');
 const initial=body(q,f.root,'analyst');
 await researchCall(f.role,f.env,'fixture',initial,undefined,{store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'});
 const value={text:'piece '.repeat(50000)},fragments:string[]=[];
 let materialOffset=0,finished=false;
 for(let n=0;n<10&&!finished;n++){
  let sent:any;
  await researchCall(f.role,f.env,'fixture',{...initial,dispatchMode:'synthesis',synthesisMaterials:[{kind:'context',value}],synthesisState:{offset:0,materialOffset},synthesisNotes:[]},undefined,
   {store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst',onContext:p=>{sent=p;}});
  assert.ok(sent.materialPage);fragments.push(sent.materialPage.text);
  materialOffset=sent.synthesisPage.nextMaterialOffset;finished=sent.synthesisPage.complete;
 }
 assert.ok(finished);assert.deepEqual(JSON.parse(fragments.join('')),value);
 const wires=readFileSync(f.log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(wires.filter(w=>JSON.stringify(w).includes('FOUNDATION_SENTINEL')).length,1);
 assert.ok(wires.slice(1).every(w=>JSON.stringify(w).length<=300000));
});

test('real evidence remains exact, while a forged observation cannot smuggle a repeated foundation',t=>{
 const f=fixture(t),{draft,q}=question(f.store,'discovery','R0','proof');
 const context=body(q,f.root,'analyst'),evidence=new Evidence(f.store);
 const source=evidence.document('p','real','real source','text/plain',0);
 const observation=evidence.observe('p',reference(source),{kind:'text-range',start:0,end:11});
 const archive=f.store.write({id:'proof-archive',kind:'research-context',expected:0,value:{projectId:'p',question:reference(q),draft:reference(draft),body:context}});
 assert.deepEqual(replaceFoundationCopies({observation},context,reference(archive),f.store).observation,observation);
 const forged={...observation,value:context.core};
 assert.ok(!JSON.stringify(replaceFoundationCopies({forged},context,reference(archive),f.store)).includes('FOUNDATION_SENTINEL'));
});

test('a real draft cannot omit question binding at the actual dispatch entry point',async t=>{
 const f=fixture(t),{draft,q}=question(f.store,'discovery','R0','missing');
 await assert.rejects(researchCall(f.role,f.env,'fixture',body(q,f.root,'reader'),undefined,{store:f.store,draftId:draft.id,purpose:'reader'}),{code:'continuation_question_missing'});
 assert.equal(f.store.list('model-call').length,0);
});

test('failed first provider response does not establish foundation delivery: retry stays initial',async t=>{
 const f=fixture(t),{draft,q}=question(f.store,'om-g2','R2','failed-initial');
 const adapter=f.role.command.args[0]!;
 writeFileSync(adapter,`import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(f.log)},JSON.stringify(r)+'\\n');if(!existsSync('failed-once')){writeFileSync('failed-once','1');process.exit(1);}console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'fixture'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const context=body(q,f.root,'analyst'),audit={store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'};
 await assert.rejects(researchCall(f.role,f.env,'fixture',context,undefined,audit),{code:'research_provider_failed'});
 const failed=f.store.list<import('../src/runtime/model-usage.js').ModelCall>('model-call')[0]!;
 assert.equal(continuationState(f.store,'p',draft.id,q.id,'analyst',f.role.actor).priorCalls,0);
 const reopened=new Store(f.path);
 try{await researchCall(f.role,f.env,'fixture',context,undefined,{...audit,store:reopened});}finally{reopened.close();}
 assert.deepEqual(f.store.get(failed.id),failed,'Failed usage and status remain in the immutable call history');
 const wires=readFileSync(f.log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.deepEqual(wires.map(w=>w.subject.continuation.kind),['initial','initial']);
 assert.ok(wires.every(w=>w.subject.core));
 const state=continuationState(f.store,'p',draft.id,q.id,'analyst',f.role.actor);
 assert.equal(state.priorCalls,1);assert.equal(state.initial,false);
});

test('a running call left by a crashed process refuses another dispatch for the same pair, including R2',async t=>{
 const f=fixture(t),{draft,q}=question(f.store,'om-g2','R2','crash');
 const context=body(q,f.root,'analyst'),audit={store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'};
 await researchCall(f.role,f.env,'fixture',context,undefined,audit);
 const call=f.store.list<import('../src/runtime/model-usage.js').ModelCall>('model-call')[0]!;
 f.store.write({id:call.id,kind:call.kind,expected:call.revision,value:{...call.value,status:'running',finishedAt:null}});
 const before=f.store.list('model-call').length,requests=readFileSync(f.log,'utf8');
 const reopened=new Store(f.path);
 try{await assert.rejects(researchCall(f.role,f.env,'fixture',context,undefined,{...audit,store:reopened}),{code:'continuation_call_active'});}finally{reopened.close();}
 assert.equal(f.store.list('model-call').length,before);assert.equal(readFileSync(f.log,'utf8'),requests);
});

test('a failed continuation cannot replace the last delivered candidate used for corrections',async t=>{
 const f=fixture(t),{draft,q}=question(f.store,'om-g2','R2','candidate-delivery');
 const context=body(q,f.root,'assessor'),audit={store:f.store,draftId:draft.id,questionId:q.id,purpose:'assessor'};
 await researchCall(f.role,f.env,'fixture',context,undefined,audit);
 const initial=continuationState(f.store,'p',draft.id,q.id,'assessor',f.role.actor);
 const adapter=f.role.command.args[0]!;
 writeFileSync(adapter,`process.stdin.resume();process.stdin.on('end',()=>process.exit(1));`);
 await assert.rejects(researchCall(f.role,f.env,'fixture',{...context,value:{changed:'not delivered'}},undefined,audit),{code:'research_provider_failed'});
 const after=continuationState(f.store,'p',draft.id,q.id,'assessor',f.role.actor);
 assert.deepEqual(after.latest,initial.latest);assert.equal(after.priorCalls,1);assert.equal(after.initial,false);
});
