import {referenceSites} from '../src/storage/reference-sites.js';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {discoveryFixture, validFrame, planQuestion, fixturePlanCoverage} from './discovery-v7-fixture.js';
import {ProductEngine} from '../src/product/engine.js';
import {Discovery, type DiscoveryDraft, type Question} from '../src/discovery/discovery.js';
import {reference, type Ref} from '../src/pipeline/contracts.js';
import {Store} from '../src/storage/store.js';
import {storeView} from '../src/storage/store-view.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {executionAdmission} from '../src/discovery/projection-reader.js';
import {ProducerPolicySessions, issueProducerPolicyInvitation, setProjectProducerPolicy} from '../src/product/producer-policy-authority.js';
import {projectProducerSelection, readProjectProducerPolicy, producerPolicyId} from '../src/discovery/project-producer-policy.js';
import {producerContractEra} from '../src/discovery/requirements.js';
import {V7_REQUIREMENTS} from '../src/discovery/v7-contracts.js';

const brief = '  Учёт материалов и расчётов подрядчика.\nДословное поручение владельца α  ';
const instruction = {id:'instruction', title:'Live entry', text:brief, media:'text/plain',
  brief:{kind:'text-range' as const,start:0,end:brief.length}};
function cli(path: string, door: string, body: unknown, success = true): any {
  const r = spawnSync(process.execPath, [resolve('dist/src/cli.js'),door,path], {input:JSON.stringify(body),encoding:'utf8'});
  if (success) assert.equal(r.status,0,r.stderr + r.stdout);
  else assert.notEqual(r.status,0,'A foreign/stale owner request must fail');
  return JSON.parse((r.stdout || r.stderr).split('\n').find(line=>line.startsWith('{'))!);
}
function policy(store: Store, discovery: 6|7, previous: Ref|null = null, project = 'p') {
  const scope = {project,discovery,previous}, sessions = new ProducerPolicySessions(store);
  const opened = sessions.exchange(issueProducerPolicyInvitation(store,scope));
  try { return setProjectProducerPolicy(store,scope,opened.authority).record; }
  finally { sessions.revoke(opened.bearer); }
}
async function world(t: TestContext, optIn = true) {
  const f = discoveryFixture(t,'omg-live-entry-',true), adapter = join(f.root,'adapter.mjs'), wire=join(f.root,'wire');
  const questions=[planQuestion('q-market','market')], frame=validFrame(questions), coverage=fixturePlanCoverage(questions);
  writeFileSync(wire,'');
  writeFileSync(adapter, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject.request?.interpretationPhase?{...r.subject,...r.subject.request}:r.subject;
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
let research={action:'pause',reason:'Calibration'};
if(c.interpretationPhase==='generate') { const q=c.frameRequest;research={contract:'frame-interpretations/v1',projectId:q.project,brief:q.brief,frame:q.frame,previousSet:q.previousSet,outcome:'no_divergence',reason:'One exact interpretation',interpretations:[]}; }
else if(c.role==='assess-answer') research={verdict:'supported',reasons:[]};
else if(c.request?.contract==='discovery-entry/v1') {const q=c.questions[0];research={action:'answer',question:q.id,value:q.field==='frame'?${JSON.stringify(frame)}:{edition:1,previous:null,frame:c.request.frame.answer,questions:${JSON.stringify(questions)},coverage:${JSON.stringify(coverage)}},citations:[{source:c.request.brief.observation.source,selector:c.request.brief.observation.selector}]};}
else if(c.question?.id) research={action:'answer',question:c.question.id,value:{type:'impossible',code:'source_unavailable',evidence:[],text:'No accessible source'},citations:[]};
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  cli(f.path,'command',{type:'create-project',project:'p',title:'Live entry'});
  const command={executable:process.execPath,args:[adapter]};
  cli(f.path,'command',{type:'configure',project:'p',expected:0,environment:{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:20000}});
  cli(f.path,'owner-project-mode',{project:'p',mode:'bypass',previous:null});
  if(optIn) cli(f.path,'owner-producer-policy',{project:'p',discovery:7,previous:null});
  // Real local model receipts supply the existing forecast contract, without invented usage/calibration rows.
  const environment=f.engine.environments.get('p');
  const probe=f.discovery.create('p','features','R0','concept',[{field:'probe',kind:'fact',prompt:'Calibrate',risk:'unknown',schema:{type:'string'}}],[],6);
  for (const purpose of ['analyst','assessor'] as const) await researchCall(environment.value[purpose==='analyst'?'implementer':'reviewer'],environment.value,
    'Calibrate',{},undefined,{store:f.store,draftId:probe.id,questionId:probe.value.questions[0]!,purpose});
  const sent=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)).slice(2);
  const begin=async()=>{
    const result=await f.engine.execute({type:'early-stage-run',project:'p',instruction,maxTurns:1,maxCalls:1});
    const draft=f.store.list<DiscoveryDraft>('discovery-draft').find(d=>d.value.fields.brief===brief)!;
    assert.ok(draft,JSON.stringify(result)); if(optIn) assert.equal(sent().length,1,JSON.stringify(result)); return draft;
  };
  return {...f,sent,begin,environment};
}

test('LIVE: owner CLI and ordinary Driver preserve the brief, enter B0, and cold public research routes continue once', {timeout:60000}, async t=>{
  const f=await world(t), draft=await f.begin(), permission=readProjectProducerPolicy(f.store,'p')!;
  assert.equal(draft.value.contractVersion,7); assert.equal(f.sent().length,1);
  assert.equal(f.sent()[0].subject.request.brief.value,brief);
  assert.equal(f.sent()[0].subject.request.objective.value,brief);
  const calls=f.store.list<any>('model-call').filter(c=>c.value.draftId===draft.id);
  assert.deepEqual(calls[0]!.value.producerPolicy,reference(permission));
  const sites=referenceSites('model-call',{...calls[0]!.value,
    budget:{segment:reference(draft)},request:{record:reference(draft)}}).map(site=>site.field);
  for(const field of ['producerPolicy','budget.segment','request.record']) assert.ok(sites.includes(field),field);
  let engine=new ProductEngine(f.open());
  await engine.execute({type:'research-stage',project:'p',draftId:draft.id,maxTurns:1});
  assert.equal(f.sent().length,2,'research-stage must buy the frame assessment, not silently restore-only');
  engine=new ProductEngine(f.open());
  await engine.execute({type:'research-draft',project:'p',draftId:draft.id,maxTurns:1});
  assert.equal(f.sent().length,3,'research-draft must buy interpretation through B0');
  await engine.execute({type:'early-stage-run',project:'p',maxTurns:2,maxCalls:2});
  assert.equal(f.sent().length,5);
  const q=(field:string)=>draft.value.questions.map(id=>engine.store.get<Question>(id)!).find(q=>q.value.spec.field===field)!;
  assert.equal(q('frame').value.status,'answered'); assert.equal(q('plan').value.status,'answered');
  assert.equal(engine.store.list<DiscoveryDraft>('discovery-draft').filter(d=>d.value.contractVersion===7).length,1);
  const repeated=cli(f.path,'owner-producer-policy',{project:'p',discovery:7,previous:null});
  assert.equal(repeated.repeated,true); assert.deepEqual(repeated.record,reference(permission));
  const before=f.sent().length; await engine.researcher.run('p',draft.id,1,undefined,{restoreOnly:true});
  assert.equal(f.sent().length,before);
});

test('LIVE: absent policy retains v6; prepare-stage observes a later owner opt-in on an existing Engine', {timeout:60000}, async t=>{
  const f=await world(t,false); const old=await f.begin();
  assert.equal(old.value.contractVersion,6); assert.equal(producerContractEra('discovery'),6);
  assert.equal(V7_REQUIREMENTS.complete.discovery,false);
  policy(f.store,7);
  await f.engine.execute({type:'create-project',project:'other',title:'Other'});
  const other=await f.engine.execute({type:'prepare-stage',project:'other',stage:'discovery'});
  assert.ok(other); assert.equal(f.store.list<DiscoveryDraft>('discovery-draft').find(d=>d.value.projectId==='other')!.value.contractVersion,6);
  const created=await f.engine.execute({type:'prepare-stage',project:'p',stage:'discovery'}) as {value:DiscoveryDraft}; assert.equal(created.value.contractVersion,7);
  const cold=new ProductEngine(f.open()); assert.equal(projectProducerSelection(cold.store,'p').policy?.discovery,7);
});

test('LIVE: authority, database, project, exact previous and corrupt provenance cannot masquerade as opt-in', t=>{
  const f=discoveryFixture(t,'omg-live-policy-',true), other=discoveryFixture(t,'omg-live-policy-foreign-',true);
  for(const x of [f,other]) x.engine.execute({type:'create-project',project:'p',title:'Policy'});
  f.engine.execute({type:'create-project',project:'q',title:'Foreign'});
  const scope={project:'p',discovery:7 as const,previous:null};
  assert.equal(cli(f.path,'command',{type:'owner-producer-policy',...scope},false).error,'command_invalid');
  assert.equal(cli(f.path,'owner-producer-policy',{project:'p',discovery:7},false).error,'producer_policy_invalid');
  assert.throws(()=>setProjectProducerPolicy(f.store,scope,{}),{code:'owner_authority_required'});
  const sessions=new ProducerPolicySessions(f.store), invitation=issueProducerPolicyInvitation(f.store,scope);
  assert.throws(()=>new ProducerPolicySessions(other.store).exchange(invitation),{code:'producer_policy_invalid'});
  const opened=sessions.exchange(invitation);
  assert.throws(()=>setProjectProducerPolicy(f.store,{...scope,project:'q'},opened.authority),{code:'owner_authority_foreign'});
  const accepted=setProjectProducerPolicy(f.store,scope,opened.authority).record;sessions.revoke(opened.bearer);
  const disabled=policy(f.store,6,reference(accepted));
  assert.throws(()=>policy(f.store,7,reference(accepted)),{code:'producer_policy_stale'});
  assert.equal(projectProducerSelection(f.store,'p',{discovery:7}).policy?.discovery,6,'Explicit code opt-in cannot override the owner');
  assert.equal(readProjectProducerPolicy(other.store,'p'),null);
  f.store.write({id:producerPolicyId('q'),kind:'project-producer-policy',expected:0,value:{...accepted.value,project:'q'}});
  assert.throws(()=>f.discovery.forStage('q','discovery','concept'),{code:'producer_policy_invalid'});
  f.store.write({id:disabled.id,kind:disabled.kind,expected:disabled.revision,value:null});
  assert.throws(()=>f.discovery.forStage('p','discovery','concept'),{code:'producer_policy_invalid'});
});

test('LIVE: policy revision races refuse draft writes and claims; already paid answers remain restorable', {timeout:60000}, async t=>{
  const f=await world(t), initial=readProjectProducerPolicy(f.store,'p')!;
  let moved=false;
  const intercepted=storeView(f.store,{write:(writes,guards)=>{
    if(!moved && writes.some(w=>w.kind==='discovery-draft')) {moved=true;policy(f.store,6,reference(initial));}
    return f.store.writeMany(writes,guards);
  }});
  assert.throws(()=>new Discovery(intercepted).forStage('p','discovery','concept'));
  assert.equal(f.store.list<DiscoveryDraft>('discovery-draft').filter(d=>d.value.contractVersion===7).length,0);
  const again=policy(f.store,7,reference(readProjectProducerPolicy(f.store,'p')!));
  const draft=await f.begin(), count=f.sent().length;
  let claimed=false;
  const changed=storeView(f.store,{write:(writes,guards)=>{
    if(!claimed && writes.some(w=>w.kind==='model-call' && w.expected===0)) {
      claimed=true; policy(f.store,6,reference(again));
    }
    return f.store.writeMany(writes,guards);
  }});
  await new ProductEngine(changed).execute({type:'research-stage',project:'p',draftId:draft.id,maxTurns:1});
  assert.equal(claimed,true,'The race must reach a genuine new paid reservation');
  const stop=readProjectProducerPolicy(f.store,'p')!;
  assert.equal(executionAdmission(f.store,f.store.get<DiscoveryDraft>(draft.id)!,'new-research',{discovery:7}).admitted,false);
  assert.equal(f.sent().length,count);
  const engine=new ProductEngine(f.open());
  await engine.researcher.run('p',draft.id,1,undefined,{restoreOnly:true});
  assert.equal(f.sent().length,count);
  assert.deepEqual(reference(readProjectProducerPolicy(engine.store,'p')!),reference(stop));
});

test('LIVE: policy change at dispatch authorization prevents stdin after a genuine reservation', {timeout:60000}, async t=>{
  const f=await world(t), draft=await f.begin(), initial=readProjectProducerPolicy(f.store,'p')!;
  const before=f.sent().length; let changed=false;
  const view=storeView(f.store,{write:(writes,guards)=>{
    if(!changed && writes.some(w=>w.kind==='model-call' && (w.value as any).execution?.phase==='authorized')) {
      changed=true; policy(f.store,6,reference(initial));
    }
    return f.store.writeMany(writes,guards);
  }});
  await new ProductEngine(view).execute({type:'research-stage',project:'p',draftId:draft.id,maxTurns:1});
  assert.equal(changed,true,'The ordinary assessment must reach its existing authorization CAS');
  assert.equal(f.sent().length,before,'No request bytes reach the provider after the refusing CAS');
  assert.equal(f.store.list<any>('model-call').filter(c=>c.value.draftId===draft.id && c.value.execution?.phase==='authorized').length,1,
    'Only the original paid author call is authorized');
  await new ProductEngine(f.open()).researcher.run('p',draft.id,1,undefined,{restoreOnly:true});
  assert.equal(f.sent().length,before);
});
