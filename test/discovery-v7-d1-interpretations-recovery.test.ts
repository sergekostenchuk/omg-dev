import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {reference,type Ref} from '../src/pipeline/contracts.js';
import {Store,type Revision,type Write} from '../src/storage/store.js';
import {createPartialV7Draft,V7_STAGE_TOKEN_CEILING} from '../src/discovery/v7-contracts.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {assessAnswer} from '../src/discovery/research-assessment.js';
import {advanceInterpretationFlow,readInterpretationFlowReadyAt,type InterpretationFlowResult} from '../src/discovery/interpretation-flow.js';
import {issueInterpretationChoiceInvitation,InterpretationChoiceSessions,chooseInterpretation} from '../src/product/interpretation-authority.js';
import {ProjectModeSessions,issueProjectModeInvitation} from '../src/product/owner-authority.js';
import {setProjectMode} from '../src/product/project-mode.js';
import {discoveryFixture,questionOf,validFrame} from './discovery-v7-fixture.js';

async function world(t:TestContext,outcome:'material'|'no_divergence'='material',mode:'questions'|'bypass'='questions', large=false) {
  const f=discoveryFixture(t,'omg-d1-paid-',true), project='p';
  const settings=join(f.root,'settings.json'), wire=join(f.root,'wire.ndjson'), adapter=join(f.root,'role.mjs');
  writeFileSync(settings,JSON.stringify({outcome,large}));
  writeFileSync(adapter,`import{readFileSync,appendFileSync,writeFileSync,existsSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));let s=r.subject.request?.interpretationPhase?{...r.subject,...r.subject.request}:r.subject;const c=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research={verdict:'supported',reasons:[]},nextRead=null;
if(c.large && (s.materialDelivery?.length || s.contextDelivery?.length || s.contextWorkspace?.length)) {
 const path=${JSON.stringify(join(f.root,'received.json'))},cache=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{chunks:{},record:null,total:null};
 for(const d of [...(s.materialDelivery??[]),...(s.contextDelivery??[])])if(d.original.pointer==='/body/request') {
   cache.record=d.original.record;cache.total=d.served.total;if((cache.chunks[d.served.offset]?.length??0)<d.text.length)cache.chunks[d.served.offset]=d.text;
 }
 for(const d of s.contextWorkspace??[])if(d.pointer==='/body/request' && d.page) {
   cache.record=d.record;cache.total=d.page.total;cache.chunks[d.page.offset]=d.value;
 }
 if(cache.record) {
   let text='',offset=0;while(typeof cache.chunks[offset]==='string' && cache.chunks[offset].length){text+=cache.chunks[offset];offset=text.length;}
   if(offset===cache.total)s={...s,...JSON.parse(text)};
   else nextRead={action:'read_context',record:cache.record,pointer:'/body/request',page:{offset,limit:12000,encoding:'canonical-json'}};
   writeFileSync(path,JSON.stringify(cache));
 }
}

if(s.interpretationPhase==='generate') {const q=s.frameRequest;
research={contract:'frame-interpretations/v1',projectId:q.project,brief:q.brief,frame:q.frame,previousSet:q.previousSet,
outcome:c.outcome,reason:'The mandate has distinct delivery consequences',interpretations:c.outcome==='material'?[
{id:'central',meaning:'One central inventory',consequences:[{affects:'boundaries',text:'All sites share one accounting boundary'}],support:[q.brief.selector]},
{id:'local',meaning:'Independent site inventories',consequences:[{affects:'acceptance',text:'Reconciliation is verified at every site'}],support:[q.brief.selector]}]:[]};}
if(s.interpretationPhase==='choose')research={action:'choose',interpretation:'local',justification:'The per-site reconciliation best fits the mandate'};
if(s.interpretationPhase==='frame')research={action:'frame',decision:s.decisionRef,value:{...s.frameRequest.subject.frame.record.value.value,scale:'Independent inventory and reconciliation at every site'}};
if(nextRead)research=nextRead;
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:c.tokens??10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  f.engine.execute({type:'create-project',project,title:'Interpretations'});
  const command={executable:process.execPath,args:[adapter]};
  let environment=f.engine.environments.configure(project,{workspace:f.root,implementer:{actor:'author',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:30000,requestCapacityChars:200000},0);
  const probe=f.discovery.create(project,'discovery','R0','concept',[{field:'probe',kind:'fact',prompt:'Calibration',risk:'unknown',schema:{type:'string'}}]);
  for(const purpose of ['analyst','assessor'])await researchCall(purpose==='analyst'?environment.value.implementer:environment.value.reviewer,environment.value,'Calibration',{},undefined,
    {store:f.store,draftId:probe.id,questionId:probe.value.questions[0]!,purpose});
  const text='Inventory is maintained centrally and reconciled independently at each site.'+(large?' Inventory belongs to a named site.'.repeat(240):'');
  const source=f.discovery.evidence.document(project,'mandate',text,'text/plain',0);
  const draft=createPartialV7Draft(f.discovery,project,'concept',[reference(source)]);
  const q=(name:string)=>questionOf(f.store,draft,name);
  f.discovery.fact(q('brief').id,q('brief').revision,reference(source),{kind:'text-range',start:0,end:text.length});
  f.discovery.decision(q('objective').id,q('objective').revision,'owner','Preserve the original mandate and explain inventory boundaries');
  const frame=q('frame');
  const assessment=await assessAnswer(f.store,frame,{action:'answer',question:frame.id,value:validFrame(),citations:[]},environment,f.root);
  const accepted=f.discovery.researched(frame.id,frame.revision,reference(assessment));
  const input={project,draft:reference(accepted),frame:q('frame').value.answer!};
  if(large)environment=f.engine.environments.configure(project,{...environment.value,requestCapacityChars:60000},environment.revision);
  const modeScope={project,mode,previous:null};
  const modes=new ProjectModeSessions(f.store),invite=issueProjectModeInvitation(f.store,modeScope);assert.ok(invite.ok);
  const login=modes.exchange({project,invitation:invite.value.invitation});assert.ok(login.ok);
  setProjectMode(f.store,modeScope,modes.authority(login.value.bearer));assert.ok(modes.revoke(login.value.bearer).ok);
  const sent=()=>existsSync(wire)?readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  const run=(store=f.store,allowance=12,restoreOnly=false)=>advanceInterpretationFlow(store,input,{allowance,restoreOnly});
  const own=(generation:Ref,store=f.store)=>{
    const scope={project,generation,interpretation:'local',justification:'Keep reconciliation per site'};
    const sessions=new InterpretationChoiceSessions(store),login=sessions.exchange(issueInterpretationChoiceInvitation(store,scope));
    try{return chooseInterpretation(store,scope,login.authority);}finally{sessions.revoke(login.bearer);}
  };
  return {...f,project,input,q,source,environment,settings,wire,sent,run,own};
}
function ready(r:InterpretationFlowResult):asserts r is Extract<InterpretationFlowResult,{kind:'ready'}> {
  assert.equal(r.kind,'ready',JSON.stringify(r));
}

test('D1 recovery: single-call invocations keep the same paid generation, choice and frame through cold reopen',async t=>{
  const f=await world(t,'material','bypass');const before=f.sent().length;
  let result:InterpretationFlowResult=await f.run(f.store,1);assert.equal(result.kind,'pending',JSON.stringify(result));assert.equal(result.callsUsed,1);
  for(let step=0;step<4 && result.kind!=='ready';step++) result=await f.run(f.open(),1);
  ready(result);assert.equal(f.sent().length-before,4);assert.equal(f.store.list('interpretation-decision').length,1);
  const repeat=await f.run(f.open(),0,true);ready(repeat);assert.equal(repeat.callsUsed,0);
});
test('D1 recovery: cut after physical payment restores the exact response without paying generation again',async t=>{
  const f=await world(t,'no_divergence');const original=Store.prototype.writeMany;let cut=true;
  Store.prototype.writeMany=function<T>(writes:Write[],guards:any=[]):Revision<T>[] {
    if(this===f.store && cut && writes.some(w=>w.kind==='interpretation-execution' && (w.value as any).step===1)) {cut=false;throw new Error('cut-after-paid');}
    return original.call(this,writes,guards) as Revision<T>[];
  };
  try{await assert.rejects(f.run(),/cut-after-paid/);}finally{Store.prototype.writeMany=original;}
  const paid=f.sent().length;const restored=await f.run(f.open(),0,true);ready(restored);assert.equal(f.sent().length,paid);assert.equal(restored.callsUsed,0);
});
test('D1 recovery: foreign or changed exact readiness refuses; issued objects remain detached',async t=>{
  const f=await world(t,'no_divergence');const done=await f.run();ready(done);
  const read=await readInterpretationFlowReadyAt(f.store,'p',done.basis);read.frame.hash='0'.repeat(64);
  const cold=await readInterpretationFlowReadyAt(f.open(),'p',done.basis);assert.deepEqual(cold.frame,done.frame);
  await assert.rejects(readInterpretationFlowReadyAt(f.store,'foreign',done.basis),{code:'interpretation_ready_invalid'});
  await assert.rejects(readInterpretationFlowReadyAt(f.store,'p',{...done.basis,hash:'0'.repeat(64)}),{code:'interpretation_basis_missing'});
  assert.equal((await f.run(f.open(),0,true)).callsUsed,0);
});
test('D1 recovery: exhausted invocation and stage budget do not become free new interpretation purchases',async t=>{
  const f=await world(t,'no_divergence');const before=f.sent().length;
  const zero=await f.run(f.store,0);assert.equal(zero.kind,'pending');assert.equal(f.sent().length,before);
  const restored=await f.run(f.store,4,true);assert.equal(restored.kind,'pending');assert.equal(f.sent().length,before);
  // Once the paid generation exists, even zero allowance restores its result.
  const done=await f.run(f.store,1);ready(done);const count=f.sent().length;
  ready(await f.run(f.open(),0,true));assert.equal(f.sent().length,count);
  const spent=await world(t,'material','bypass');
  writeFileSync(spent.settings,JSON.stringify({outcome:'material',tokens:V7_STAGE_TOKEN_CEILING+1}));
  const start=spent.sent().length,blocked=await spent.run();
  assert.notEqual(blocked.kind,'ready');if(blocked.kind==='ready')assert.fail();
  assert.equal(blocked.code,'discovery_budget_overrun',JSON.stringify(blocked));assert.equal(spent.sent().length-start,1);
  const repeated=await spent.run(spent.open());assert.notEqual(repeated.kind,'ready');assert.equal(spent.sent().length-start,1);
});

test('D1 recovery: bounded generation reads every delivered request page before publishing no_divergence',async t=>{
  const f=await world(t,'no_divergence','questions',true),start=f.sent().length;
  const done=await f.run(f.store,24);ready(done);
  const sent=f.sent().slice(start);assert.ok(sent.length>1);assert.ok(sent.some(w=>w.subject.materialDelivery?.length));
  assert.ok(sent.every(w=>JSON.stringify(w).length<=60000));
  const saved=JSON.parse(readFileSync(join(f.root,'received.json'),'utf8'));
  assert.ok(Object.keys(saved.chunks).length>1);
  let text='',offset=0;while(saved.chunks[offset]){text+=saved.chunks[offset];offset=text.length;}
  assert.equal(offset,saved.total);const request=JSON.parse(text).frameRequest;
  assert.deepEqual(request.brief.source,reference(f.source));assert.ok(text.includes('Inventory belongs to a named site.'));
  const calls=f.sent().length;ready(await f.run(f.open(),0,true));assert.equal(f.sent().length,calls);
});
