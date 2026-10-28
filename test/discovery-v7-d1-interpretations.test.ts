import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {canonical} from '../src/canonical.js';
import {reference,type Ref} from '../src/pipeline/contracts.js';
import {createPartialV7Draft} from '../src/discovery/v7-contracts.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {assessAnswer} from '../src/discovery/research-assessment.js';
import {advanceInterpretationFlow,type InterpretationFlowResult} from '../src/discovery/interpretation-flow.js';
import {readInterpretationExecutionAt,readInterpretationDecisionAt} from '../src/discovery/interpretation-execution.js';
import {issueInterpretationChoiceInvitation,InterpretationChoiceSessions,chooseInterpretation} from '../src/product/interpretation-authority.js';
import {ProjectModeSessions,issueProjectModeInvitation} from '../src/product/owner-authority.js';
import {setProjectMode} from '../src/product/project-mode.js';
import {discoveryFixture,questionOf,validFrame} from './discovery-v7-fixture.js';

async function world(t:TestContext,outcome:'material'|'no_divergence'='material',mode:'questions'|'bypass'='questions') {
  const f=discoveryFixture(t,'omg-d1-paid-',true), project='p';
  const settings=join(f.root,'settings.json'), wire=join(f.root,'wire.ndjson'), adapter=join(f.root,'role.mjs');
  writeFileSync(settings,JSON.stringify({outcome}));
  writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject.request?.interpretationPhase?{...r.subject,...r.subject.request}:r.subject,c=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research={verdict:'supported',reasons:[]};
if(s.interpretationPhase==='generate') {const q=s.frameRequest;
research={contract:'frame-interpretations/v1',projectId:q.project,brief:q.brief,frame:q.frame,previousSet:q.previousSet,
outcome:c.outcome,reason:'The mandate has distinct delivery consequences',interpretations:c.outcome==='material'?[
{id:'central',meaning:'One central inventory',consequences:[{affects:'boundaries',text:'All sites share one accounting boundary'}],support:[q.brief.selector]},
{id:'local',meaning:'Independent site inventories',consequences:[{affects:'acceptance',text:'Reconciliation is verified at every site'}],support:[q.brief.selector]}]:[]};}
if(s.interpretationPhase==='choose')research={action:'choose',interpretation:'local',justification:'The per-site reconciliation best fits the mandate'};
if(s.interpretationPhase==='frame')research={action:'frame',decision:c.foreignDecision??s.decisionRef,value:{...s.frameRequest.subject.frame.record.value.value,scale:'Independent inventory and reconciliation at every site'}};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:c.tokens??10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  f.engine.execute({type:'create-project',project,title:'Interpretations'});
  const command={executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure(project,{workspace:f.root,implementer:{actor:'author',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:30000,requestCapacityChars:200000},0);
  const probe=f.discovery.create(project,'discovery','R0','concept',[{field:'probe',kind:'fact',prompt:'Calibration',risk:'unknown',schema:{type:'string'}}]);
  for(const purpose of ['analyst','assessor'])await researchCall(purpose==='analyst'?environment.value.implementer:environment.value.reviewer,environment.value,'Calibration',{},undefined,
    {store:f.store,draftId:probe.id,questionId:probe.value.questions[0]!,purpose});
  const text='Inventory is maintained centrally and reconciled independently at each site.';
  const source=f.discovery.evidence.document(project,'mandate',text,'text/plain',0);
  const draft=createPartialV7Draft(f.discovery,project,'concept',[reference(source)]);
  const q=(name:string)=>questionOf(f.store,draft,name);
  f.discovery.fact(q('brief').id,q('brief').revision,reference(source),{kind:'text-range',start:0,end:text.length});
  f.discovery.decision(q('objective').id,q('objective').revision,'owner','Preserve the original mandate and explain inventory boundaries');
  const frame=q('frame');
  const assessment=await assessAnswer(f.store,frame,{action:'answer',question:frame.id,value:validFrame(),citations:[]},environment,f.root);
  const accepted=f.discovery.researched(frame.id,frame.revision,reference(assessment));
  const input={project,draft:reference(accepted),frame:q('frame').value.answer!};
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

test('D1: paid no_divergence reaches readiness without an owner question, and repeats free hot/cold',async t=>{
  const f=await world(t,'no_divergence'); const before=f.sent().length;
  const result=await f.engine.execute({type:'interpret-discovery-frame',...f.input,allowance:12,restoreOnly:false}) as InterpretationFlowResult;ready(result);assert.equal(result.outcome,'no_divergence');assert.deepEqual(result.frame,f.input.frame);
  assert.equal(result.callsUsed,1);assert.equal(f.sent().length-before,1);assert.equal(f.store.list('interpretation-decision').length,0);
  const state=canonical(f.store.list()),repeat=await f.run(f.open(),0,true);ready(repeat);assert.equal(repeat.callsUsed,0);
  assert.equal(canonical(f.store.list()),state);assert.deepEqual(await f.engine.execute({type:'read-interpretation-ready',project:'p',basis:result.basis}),{...result,callsUsed:0});
});
test('D1: questions preserves consequences, waits for scoped owner choice, then applies and assesses the frame',async t=>{
  const f=await world(t);const original=canonical(f.store.history(f.input.draft.id));
  const waiting=await f.run();assert.equal(waiting.kind,'owner_required',JSON.stringify(waiting));
  assert.ok(waiting.continuation.set);const generation=waiting.continuation.generation!;
  const generated=readInterpretationExecutionAt(f.store,'p',generation);assert.equal((generated.value.result as any).interpretations.length,2);
  assert.equal(canonical(f.store.history(f.input.draft.id)),original);
  const scope={project:'p',generation,interpretation:'local',justification:'Keep reconciliation per site'};
  assert.throws(()=>chooseInterpretation(f.store,scope,{owner:true}),{code:'owner_authority_required'});
  assert.throws(()=>f.engine.execute({type:'choose-frame-interpretation',...scope}),{code:'owner_authority_required'});
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),'owner-frame-interpretation',f.path],
    {input:JSON.stringify({type:'choose-frame-interpretation',...scope}),encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);const decision=JSON.parse(cli.stdout);assert.equal(decision.value.origin.kind,'owner');
  assert.equal(f.store.list<any>('owner-session').filter(r=>r.value.contract==='interpretation-choice-session/v1' && r.value.revokedAt===null).length,0);
  const done=await f.run();ready(done);assert.equal(done.outcome,'material');assert.notDeepEqual(done.frame,f.input.frame);
  assert.equal(f.q('frame').value.status,'answered');assert.equal(f.store.get<any>(done.draft.id)!.value.fields.frame.scale,'Independent inventory and reconciliation at every site');
  assert.equal(f.store.get<any>(done.draft.id)!.value.fields.brief,f.store.get<any>(f.input.draft.id,f.input.draft.revision)!.value.fields.brief);
  assert.ok(f.sent().some(w=>w.subject.v7Frame));assert.equal(f.store.list('interpretation-decision').length,1);
});
test('D1: bypass pays distinct generation, choice and application; the model decision never becomes owner authority',async t=>{
  const f=await world(t,'material','bypass'),before=f.sent().length;
  const done=await f.run();ready(done);assert.equal(done.callsUsed,4);assert.equal(f.sent().length-before,4);
  const chosen=f.store.list<any>('interpretation-decision')[0]!;assert.equal(chosen.value.origin.kind,'model');
  readInterpretationDecisionAt(f.store,'p',reference(chosen));assert.equal(f.store.list('owner-session-grant').filter(r=>(r.value as any).contract==='interpretation-choice-grant/v1').length,0);
  const again=await f.run(f.open(),0,true);ready(again);assert.equal(again.callsUsed,0);assert.equal(f.sent().length-before,4);
});
test('D1: foreign exact inputs and JSON authority flags cannot authorize generation or choice',async t=>{
  const f=await world(t);const before=f.sent().length;
  const refused=await advanceInterpretationFlow(f.store,{...f.input,frame:reference(f.source)},{allowance:10,restoreOnly:false});
  assert.equal(refused.kind,'refused');assert.equal(f.sent().length,before);
  assert.throws(()=>f.engine.execute({type:'choose-frame-interpretation',project:'p',generation:f.input.frame,interpretation:'local',justification:'x',owner:true}),{code:'command_invalid'});
  const stopped=await f.run(f.store,0);assert.equal(stopped.kind,'pending');assert.equal(f.sent().length,before);
});

test('D1: a paid frame proposal cannot apply another generated set or decision',async t=>{
  const f=await world(t),other=await world(t);
  const a=await f.run(),b=await other.run();assert.equal(a.kind,'owner_required');assert.equal(b.kind,'owner_required');
  const own=f.own(a.continuation.generation!),foreign=other.own(b.continuation.generation!);
  assert.throws(()=>chooseInterpretation(f.store,{project:'p',generation:b.continuation.generation!,interpretation:'local',justification:'Foreign'},{}),{code:'interpretation_basis_missing'});
  writeFileSync(f.settings,JSON.stringify({outcome:'material',foreignDecision:reference(foreign)}));
  const before=f.sent().length,result=await f.run();assert.notEqual(result.kind,'ready');if(result.kind==='ready')throw new Error('Foreign decision applied');
  assert.equal(result.code,'interpretation_frame_invalid');assert.deepEqual(f.q('frame').value.answer,f.input.frame);
  assert.equal(f.store.list('interpretation-application').length,0);assert.equal(f.store.list('interpretation-ready').length,0);
  assert.deepEqual(readInterpretationDecisionAt(f.store,'p',reference(own)),own);
  assert.equal(f.sent().length-before,1);const repeated=await f.run(f.open(),0,true);assert.notEqual(repeated.kind,'ready');assert.equal(f.sent().length-before,1);
});
