import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {configureReaderPilot} from '../src/discovery/reader-pilot.js';
import {synthesisSession} from '../src/discovery/synthesis-session.js';
import {assessmentSession} from '../src/discovery/assessment-session.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {withInvocationAllowance} from '../src/discovery/invocation-progress.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {reference} from '../src/pipeline/contracts.js';
import type {Question} from '../src/discovery/discovery.js';
import type {ModelCall} from '../src/runtime/model-usage.js';
import {processStart,probeProcessIdentity,writeProcessStopWitness,processStopWitnesses,type ProcessStopWitness} from '../src/runtime/process-identity.js';
import {readLateModelReceipt,recoverModelCall} from '../src/discovery/model-call-recovery.js';
import {EngineError} from '../src/errors.js';

function fixture(t:test.TestContext,role:'analyst'|'assessor',scenario='combine'){
 const root=mkdtempSync(join(tmpdir(),'omg-session-audit-')),store=new Store(join(root,'db.sqlite')),engine=new ProductEngine(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 engine.execute({type:'create-project',project:'p',title:'Fixture'});
 const wire=join(root,'wire.ndjson'),adapter=join(root,'adapter.mjs');
 const source=engine.discovery.evidence.document('p','proof','AB','text/plain',0);
 const citations=[{source:reference(source),selector:{kind:'text-range',start:0,end:2}}];
 writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
if(!c.question.schema?.properties?.result)throw Error('Response contract was lost');
const entries=c.contextWorkspace??[],a=entries.find(e=>e.pointer==='/body/resources/a'),b=entries.find(e=>e.pointer==='/body/resources/b');
let research;
if(!a||!b||${JSON.stringify(scenario)}==='alternate'){
 const pointer=!a?'/body/resources/a':!b?'/body/resources/b':'/body/resources/a';
 const purpose=!a?'Retrieve original A, which is required to compute the combined result':!b?'Retrieve original B, which is required to compute the combined result':'Check original A for an exception that would change the combined result';
 research={action:'read_context',record:c.working.archive,pointer,purpose};
}else if(c.role==='assess-answer'){
 if(c.value.result!==a.value+b.value)throw Error('Candidate does not match both originals');research={verdict:'supported',reasons:[]};
}else research={action:'answer',question:c.question.id,value:{result:a.value+b.value},citations:${JSON.stringify(citations)}};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const command={executable:process.execPath,args:[adapter]};
 const env=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 const pilot=configureReaderPilot(store,engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'high',speed:'inherited',command},agentCommand:command,maxCalls:50,maxReportedTokens:100000,maxRequestChars:40000,maxContinuationChars:40000,maxReadChars:20000,maxReplyChars:10000},0);
 const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'combine',kind:'design',prompt:'Combine A and B using both originals',risk:'Losing one operand',schema:{type:'object',required:['result'],properties:{result:{type:'string'}},additionalProperties:false}}]);
 const q=store.get<Question>(draft.value.questions[0]!)!;
 const context={role:role==='analyst'?'research':'assess-answer',question:{id:q.id,...q.value.spec},resources:{a:'A',b:'B'},workingSelections:[],readings:[],value:{result:'AB'},observations:[engine.discovery.evidence.observe('p',reference(source),{kind:'text-range',start:0,end:2})]};
 const run=(db=store)=>role==='analyst'?synthesisSession(db,draft,q,env,env.value,pilot,context,'Use both operands'):assessmentSession(db,draft,q,env,env.value,pilot,context,'Judge using both operands');
 return {store,root,wire,env,pilot,draft,q,context,run};
}
for(const role of ['analyst','assessor'] as const){
 test(`${role}: stateless A then B remain available together with the response contract`,async t=>{
  const f=fixture(t,role);const result=await f.run() as any;
  assert.equal(role==='analyst'?result.value.result:result.verdict,role==='analyst'?'AB':'supported');
  const wire=readFileSync(f.wire,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(wire.length,3);
  assert.deepEqual(wire[2].subject.contextWorkspace.map((x:any)=>x.value),['A','B']);
  assert.ok(wire.every(w=>w.subject.question.schema));
  assert.ok(wire.every(w=>JSON.stringify(w).length<=40000));
 });
 test(`${role}: A/B/A across fresh archives pauses before a fourth paid call and remains paused after reopen`,async t=>{
  const f=fixture(t,role,'alternate');await assert.rejects(f.run(),{code:'research_no_progress'});
  const before=readFileSync(f.wire,'utf8');assert.equal(before.trim().split('\n').length,3);
  f.store.close();
  const db=new Store(join(f.root,'db.sqlite'));
  try{await assert.rejects(f.run(db),{code:'research_no_progress'});}finally{db.close();}
  assert.equal(readFileSync(f.wire,'utf8'),before);
 });
}
test('distinct inner calls are governed by their transport budget rather than an invocation-count ceiling',async t=>{
 const f=fixture(t,'analyst');
 writeFileSync(f.env.value.implementer.command.args[0]!,`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'unchanged'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 for(let n=0;n<4;n++)await researchCall(f.env.value.implementer,f.env.value,'fixture',{...f.context,focus:{randomArchive:n}},undefined,{store:f.store,draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',pilot:f.pilot});
 assert.equal(f.store.list('model-call').length,4);
});

test('outer analyst retains both addressed originals and rejects A/B/A before another paid dispatch',async t=>{
 const f=fixture(t,'analyst');
 writeFileSync(f.env.value.implementer.command.args[0]!,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
appendFileSync(${JSON.stringify(f.wire)},JSON.stringify(r)+'\\n');
const entries=c.contextWorkspace??[],pointer=entries.length===1?'/body/level':'/body/stage';
const purpose=pointer==='/body/level'?'Retrieve the required level before deciding the draft':'Retrieve the required stage before deciding the draft';
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'read_context',record:c.working.archive,pointer,purpose},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const engine=new ProductEngine(f.store);
 const run=await engine.execute({type:'research-draft',project:'p',draftId:f.draft.id,maxTurns:10}) as any;
 assert.equal(run.value.pauseCode,'research_no_progress');
 const wire=readFileSync(f.wire,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(wire.length,3);
 assert.deepEqual(wire[2].subject.contextWorkspace.map((entry:any)=>entry.pointer),['/body/stage','/body/level']);
 assert.equal(f.store.list('model-call').length,3);
 assert.equal(f.store.list('question-dispatch').length,1);
 assert.equal(f.store.list('project-dispatch').length,1);
});

test('addressed context omitted before dispatch produces no paid model call',async t=>{
 const f=fixture(t,'analyst');
 const request={...f.context,contextWorkspace:[{record:reference(f.q),pointer:'/body/resources/a',value:'x'.repeat(100000)}]};
 await assert.rejects(researchCall(f.env.value.implementer,f.env.value,'fixture',request,undefined,
  {store:f.store,draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',pilot:f.pilot}),{code:'research_context_undelivered'});
 assert.equal(f.store.list('model-call').length,0);
});
test('explicit caller-owned invocation allowance still stops a bounded preparation loop',async t=>{
 const f=fixture(t,'analyst');
 writeFileSync(f.env.value.implementer.command.args[0]!,`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'fixture'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 await assert.rejects(withInvocationAllowance(2,async()=>{for(const purpose of ['reader','analyst','assessor'])await researchCall(f.env.value.implementer,f.env.value,'fixture',f.context,undefined,{store:f.store,draftId:f.draft.id,questionId:f.q.id,purpose,pilot:f.pilot});}),{code:'research_call_allowance'});
 assert.equal(f.store.list('model-call').length,2);
});

test('three distinct required originals are real progress and can be combined in a fourth invocation',async t=>{
 const f=fixture(t,'analyst');
 writeFileSync(f.env.value.implementer.command.args[0]!,`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;
const entries=c.contextWorkspace??[],missing=['a','b','c'].find(key=>!entries.some(e=>e.pointer==='/body/resources/'+key));
const research=missing?{action:'read_context',record:c.working.archive,pointer:'/body/resources/'+missing,purpose:'Retrieve original '+missing.toUpperCase()+' required to compute the three-original result'}:{action:'answer',question:c.question.id,value:{result:entries.map(e=>e.value).join('')},citations:${JSON.stringify(f.context.observations.map(o=>({source:o.source,selector:o.selector})))} };
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const result=await synthesisSession(f.store,f.draft,f.q,f.env,f.env.value,f.pilot,{...f.context,resources:{a:'A',b:'B',c:'C'}},'Combine all three');
 assert.equal((result as any).value.result,'ABC');assert.equal(f.store.list('model-call').length,4);
});

// A proven-absent identity: our own short-lived child exits by itself, then
// the strict probe (status=1, empty stdout/stderr, no observation error) must
// confirm absence. Anything else is a diagnostic failure, never a skip.
async function provenAbsentIdentity(){
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},300)'],{stdio:'ignore'});
 const pid=child.pid;if(!pid)throw new Error('fixture child did not start');
 const started=processStart(pid);if(!started)throw new Error(`could not record fixture child ${pid} identity`);
 await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});
 for(let i=0;i<50;i++){
  const probe=probeProcessIdentity(pid);
  if(probe.state==='absent'||(probe.state==='present'&&probe.started!==started))return{pid,started};
  await new Promise(r=>setTimeout(r,40));
 }
 throw new Error(`could not prove absence of fixture pid ${pid}`);
}

test('lost-call recovery rejects live/unknown/foreign/stale identities and preserves unknown usage',async t=>{
 const f=fixture(t,'analyst');
 const seed=(suffix:string,owner:any,provider:any)=>f.store.write<ModelCall>({id:'model-call:'+suffix,kind:'model-call',expected:0,value:{projectId:'p',draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',requestId:suffix,startedAt:1,finishedAt:null,status:'running',requested:f.env.value.implementer,confirmed:{model:null,effort:null,speed:null},request:{chars:20,bytes:20,hash:'0'.repeat(64)},response:null,usage:null,usageSource:'unavailable',error:null,...(owner?{ownerProcess:owner}:{}),...(provider?{providerProcess:provider}:{})}});
 const live={pid:process.pid,started:processStart(process.pid)},gone=await provenAbsentIdentity();
 const recover=(call:any,project='p')=>new ProductEngine(f.store).execute({type:'recover-model-call',project,call:reference(call)});
 for(const [name,owner,provider,code] of [['owner',live,gone,'model_call_still_running'],['provider',gone,live,'model_call_still_running'],['legacy',null,null,'model_call_identity_missing'],['spawn-window',gone,null,'model_call_identity_missing']] as const){
  const call=seed(name,owner,provider);assert.throws(()=>recover(call),{code});assert.deepEqual(f.store.get(call.id),call);
 }
 const call=seed('lost',gone,gone);
 assert.throws(()=>recover({...call,hash:'f'.repeat(64)}),{code:'model_call_foreign'});
 const recovered=recover(call) as any;assert.equal(recovered.value.status,'failed');assert.equal(recovered.value.usage,null);
 assert.equal(recovered.value.error,'process_lost');assert.equal(f.store.list('model-call-recovery').length,1);
 assert.throws(()=>recover(call),{code:'model_call_foreign'});
});

// A pid whose group is provably still executing. The fixture child idles until
// the test kills its own group in t.after.
async function liveSpawnedIdentity(){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 await once(child,'spawn');const pid=child.pid;if(!pid)throw new Error('fixture child did not start');
 for(let i=0;i<50;i++){const probe=probeProcessIdentity(pid);if(probe.state==='present')return{pid,started:probe.started,child};
  if(probe.state==='unavailable')await new Promise(r=>setTimeout(r,40));else throw new Error('fixture child died early');}
 throw new Error(`could not observe fixture pid ${pid}`);
}
async function provenAbsent(pid:number){for(let i=0;i<80;i++){if(probeProcessIdentity(pid).state==='absent')return;await new Promise(r=>setTimeout(r,40));}
 throw new Error(`pid ${pid} is still provably present`);}

test('№1631-2 C18/C46: a claimed call with a live witness pid stays running until its end is proven',async t=>{
 const f=fixture(t,'analyst');
 const gone=await provenAbsentIdentity(),spawned=await liveSpawnedIdentity();
 t.after(()=>{try{process.kill(-spawned.pid,'SIGKILL')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}});
 const call=f.store.write<ModelCall>({id:'model-call:claimed-wit',kind:'model-call',expected:0,
  value:{projectId:'p',draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',requestId:'claimed-wit',startedAt:1,finishedAt:null,
   status:'running',requested:f.env.value.implementer,confirmed:{model:null,effort:null,speed:null},
   request:{chars:20,bytes:20,hash:'0'.repeat(64)},response:null,usage:null,usageSource:'unavailable',error:null,
   ownerProcess:gone,execution:{version:'model-execution/v1',phase:'claimed',owner:gone,provider:null}}});
 // The refused authorization left a spawned provider the record never learned:
 // child:null on the witness, only the raw pid.
 writeProcessStopWitness(f.store,reference(call),{owner:gone,child:null,pid:spawned.pid},
  new EngineError('process_stop_denied','denied',{outcome:'denied',stage:'signal',target:'group',pid:spawned.pid,errno:'EPERM',cause:null}));
 const recover=(c:typeof call)=>new ProductEngine(f.store).execute({type:'recover-model-call',project:'p',call:reference(c)});
 // The claimed phase does not prove the spawned process is gone: recovery must
 // refuse while its pid is present, and the claim must stay running.
 assert.throws(()=>recover(call),{code:'model_call_process_uncertain'});
 assert.equal(f.store.get<ModelCall>(call.id)!.value.status,'running');
 assert.equal(probeProcessIdentity(spawned.pid).state,'present');
 // A witness of a FOREIGN subject id must not leak into this call's check:
 // it neither blocks nor authorizes anything here.
 writeProcessStopWitness(f.store,{id:'model-call:other',revision:1,hash:'e'.repeat(64)},{child:null,pid:spawned.pid},
  new EngineError('process_stop_denied','denied',{outcome:'denied',stage:'signal',target:'group',pid:spawned.pid,errno:'EPERM',cause:null}));
 assert.equal(processStopWitnesses(f.store,call.id).length,1,'the foreign witness is not attached to this call');
 process.kill(-spawned.pid,'SIGKILL');await provenAbsent(spawned.pid);
 const closed=recover(call) as any;
 assert.equal(closed.value.status,'failed');assert.equal(closed.value.error,'process_lost');
});

test('№1631-3 C24/C46/C47: a complete paid result in the stop witness becomes a late receipt on proved recovery',async t=>{
 const f=fixture(t,'analyst');
 const owner=await provenAbsentIdentity(),provider=await provenAbsentIdentity();
 const call=f.store.write<ModelCall>({id:'model-call:paid-wit',kind:'model-call',expected:0,
  value:{projectId:'p',draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',requestId:'paid-wit',startedAt:1,finishedAt:null,
   status:'running',requested:f.env.value.implementer,confirmed:{model:null,effort:null,speed:null},
   request:{chars:20,bytes:20,hash:'0'.repeat(64)},response:null,usage:null,usageSource:'unavailable',error:null,
   ownerProcess:owner,providerProcess:{pid:provider.pid,started:provider.started},
   execution:{version:'model-execution/v1',phase:'authorized',owner,provider:{pid:provider.pid,started:provider.started,group:provider.pid}}}});
 const physical=(complete:boolean)=>Object.defineProperty(
  new EngineError('process_stop_denied','denied',{outcome:'denied',stage:'group-sweep',target:'group',pid:provider.pid,errno:'EPERM',cause:null}),
  'physical',{value:{exitCode:0,signal:null,stdout:'{"research":{"answer":"paid-saved-result"}}',stderr:'',complete},enumerable:false}) as EngineError;
 writeProcessStopWitness(f.store,reference(call),{owner,child:provider,pid:provider.pid},physical(true));
 const recovered=recoverModelCall(f.store,'p',reference(call));
 assert.equal(recovered.value.status,'failed');assert.equal(recovered.value.error,'process_lost');
 assert.equal(recovered.value.response,null,'the saved bytes are evidence, never an auto-applied response');
 const late=readLateModelReceipt(f.store,'p',reference(recovered));
 assert.ok(late);assert.equal(late!.value.evidence.process!.stdout,'{"research":{"answer":"paid-saved-result"}}');
 assert.deepEqual(late!.value.dispatch,reference(call));assert.equal(late!.value.evidence.launchError,null);
 // A partial stream is not a complete result: it stays in the witness only.
 const owner2=await provenAbsentIdentity(),provider2=await provenAbsentIdentity();
 const partial=f.store.write<ModelCall>({id:'model-call:partial-wit',kind:'model-call',expected:0,
  value:{projectId:'p',draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',requestId:'partial-wit',startedAt:1,finishedAt:null,
   status:'running',requested:f.env.value.implementer,confirmed:{model:null,effort:null,speed:null},
   request:{chars:20,bytes:20,hash:'0'.repeat(64)},response:null,usage:null,usageSource:'unavailable',error:null,
   ownerProcess:owner2,providerProcess:{pid:provider2.pid,started:provider2.started},
   execution:{version:'model-execution/v1',phase:'authorized',owner:owner2,provider:{pid:provider2.pid,started:provider2.started,group:provider2.pid}}}});
 writeProcessStopWitness(f.store,reference(partial),{owner:owner2,child:provider2,pid:provider2.pid},physical(false));
 const closedPartial=recoverModelCall(f.store,'p',reference(partial));
 assert.equal(closedPartial.value.error,'process_lost');
 assert.equal(readLateModelReceipt(f.store,'p',reference(closedPartial)),null);
});

test('D8.5 r3 rows 3/9: paid evidence is accepted only from the exact dispatch subject',async t=>{
 const f=fixture(t,'analyst');
 const owner=await provenAbsentIdentity(),provider=await provenAbsentIdentity();
 const call=f.store.write<ModelCall>({id:'model-call:bound-wit',kind:'model-call',expected:0,
  value:{projectId:'p',draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',requestId:'bound-wit',startedAt:1,finishedAt:null,
   status:'running',requested:f.env.value.implementer,confirmed:{model:null,effort:null,speed:null},
   request:{chars:20,bytes:20,hash:'0'.repeat(64)},response:null,usage:null,usageSource:'unavailable',error:null,
   ownerProcess:owner,providerProcess:{pid:provider.pid,started:provider.started},
   execution:{version:'model-execution/v1',phase:'authorized',owner,provider:{pid:provider.pid,started:provider.started,group:provider.pid}}}});
 const physical=Object.defineProperty(
  new EngineError('process_stop_denied','denied',{outcome:'denied',stage:'group-sweep',target:'group',pid:provider.pid,errno:'EPERM',cause:null}),
  'physical',{value:{exitCode:0,signal:null,stdout:'{"research":{"answer":"paid-saved-result"}}',stderr:'',complete:true},enumerable:false}) as EngineError;
 writeProcessStopWitness(f.store,reference(call),{owner,child:provider,pid:provider.pid},physical);
 const wid=`process-stop:${call.id}:${call.revision}`;
 // Row 3: a tampered subject hash is foreign — it cannot release the claim or
 // pay this recovery. The call stays running; no receipt is created.
 const witness=f.store.get<ProcessStopWitness>(wid)!;
 f.store.write({id:witness.id,kind:witness.kind,expected:witness.revision,
  value:{...witness.value,subject:{...witness.value.subject,hash:'0'.repeat(64)}}});
 assert.throws(()=>recoverModelCall(f.store,'p',reference(call)),{code:'process_stop_witness_foreign'});
 assert.equal(f.store.get<ModelCall>(call.id)!.value.status,'running');
 assert.equal(f.store.list('model-late-receipt').length,0);
 // A well-formed witness of an OLDER revision of this call is real evidence —
 // but row 9: it is not THIS dispatch, so it may end the claim yet never pay.
 const current=f.store.get(wid)!;
 f.store.write({id:witness.id,kind:witness.kind,expected:current.revision,value:witness.value});
 const advanced=f.store.write<ModelCall>({id:call.id,kind:call.kind,expected:call.revision,
  value:{...call.value,requestId:'bound-wit-again'}});
 const closed=recoverModelCall(f.store,'p',reference(advanced));
 assert.equal(closed.value.status,'failed');assert.equal(closed.value.error,'process_lost');
 assert.equal(readLateModelReceipt(f.store,'p',reference(closed)),null,'paid evidence must name the exact dispatch revision');
});

test('№1631-4 C28: an identity refusal before authorization keeps a recoverable running claim',async t=>{
 const f=fixture(t,'analyst');
 const writeMany=f.store.writeMany.bind(f.store);let injected=false;
 (f.store as {writeMany:unknown}).writeMany=(writes:{kind:string;value:{execution?:{phase?:string}}}[],guards:unknown[] = [])=>{
  if(!injected&&writes.some(w=>w.kind==='model-call'&&w.value.execution?.phase==='authorized')){
   injected=true;throw new EngineError('process_identity_unavailable','injected unavailable provider identity before authorization');}
  return writeMany(writes as never,guards as never);};
 let failure:EngineError|null=null;
 try{await researchCall(f.env.value.implementer,f.env.value,'fixture',f.context,undefined,
  {store:f.store,draftId:f.draft.id,questionId:f.q.id,purpose:'analyst',pilot:f.pilot});}
 catch(e){failure=e as EngineError;}
 (f.store as {writeMany:unknown}).writeMany=writeMany;
 assert.equal(failure?.code,'process_identity_unavailable');
 const call=f.store.list<ModelCall>('model-call')[0]!;
 // No unreadable no-response terminal: the claim stays running, the spawned
 // provider pid survives in the witness, and no failed/finishedAt was written.
 assert.equal(call.value.status,'running');assert.equal(call.value.error,null);assert.equal(call.value.finishedAt,null);
 const witness=processStopWitnesses(f.store,call.id)[0]!.value as ProcessStopWitness;
 assert.ok(witness.pid&&witness.pid>0);assert.equal(witness.child,null);
 await provenAbsent(witness.pid);
 // The claim is genuinely recoverable, not silently terminal: while the owner
 // (this process) is alive, recovery refuses as still-running rather than
 // misreading it as a finished failure.
 assert.throws(()=>recoverModelCall(f.store,'p',reference(call)),{code:'model_call_still_running'});
});

test('assessment receives every candidate fragment and retains a contradiction across evidence pages',async t=>{
 const f=fixture(t,'assessor');
 writeFileSync(f.env.value.reviewer.command.args[0]!,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync(${JSON.stringify(f.wire)},JSON.stringify(r)+'\\n');
if(!c.question.schema||!c.candidatePage)throw Error('No candidate contract');
const p=c.candidatePage,prior=(c.conclusions??[]).some(n=>n.response?.notes?.includes('contradiction'));
const bad=prior||(p.text??JSON.stringify(c.value)).includes('MUST_REJECT');
const research=p.complete&&c.evidencePage.complete?{verdict:bad?'conflicting':'supported',reasons:bad?['The candidate contains the forbidden effect']:[]}:{action:'assessment_checkpoint',notes:[bad?'contradiction':'no contradiction on this fragment']};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const value={result:'MUST_REJECT '+ 'x'.repeat(85000)};
 const result=await assessmentSession(f.store,f.draft,f.q,f.env,f.env.value,f.pilot,{...f.context,value},'Detect contradictions') as any;
 assert.equal(result.verdict,'conflicting');
 const wire=readFileSync(f.wire,'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.ok(wire.length>3);assert.ok(wire.every(w=>JSON.stringify(w).length<=40000));
 assert.equal(wire.map(w=>w.subject.candidatePage.text).join(''),JSON.stringify(value));
 assert.ok(wire.at(-1).subject.candidatePage.complete);
});
