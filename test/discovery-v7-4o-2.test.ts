import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { reference } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { VARIANT_OWNER_ACTION, type VariantChoiceScope } from '../src/discovery/variant-decision.js';
import { issueVariantChoiceInvitation, VariantChoiceSessions } from '../src/product/owner-authority.js';
import { answerVariantChoice, readVariantOwnerDecision } from '../src/discovery/discovery-decision.js';
import type { OmResult } from '../src/om/refusal.js';
function ok<T>(result: OmResult<T>): T {
  assert.equal(result.ok,true,result.ok?undefined:result.refusal.code);
  return (result as {ok:true;value:T}).value;
}
const history=(store:Store)=>store.list().flatMap(row=>store.history(row.id));
const refuses=(invoke:()=>unknown,code?:string)=>assert.throws(invoke,(error:unknown)=>
  error instanceof EngineError && (!code || error.code===code));
import { writeFileSync } from 'node:fs';
import { hashJson } from '../src/canonical.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { runVariantSession, prepareVariantSession, applyVariantSession, readVariantModelDecision, type VariantSessionInput } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantSet } from '../src/discovery/discovery-variants.js';
import { variantStateId } from '../src/discovery/variant-decision.js';
import { ProjectModeSessions, issueProjectModeInvitation } from '../src/product/owner-authority.js';
import { setProjectMode } from '../src/product/project-mode.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

const generation=()=>({action:'variants',variants:[{key:'one',title:'One bounded variant',proposal:{scope:'common'},
  criteria:Object.fromEntries(VARIANT_CRITERIA.map(key=>[key,{conclusion:'Bounded by the paid sweep',grounds:[],assumptions:[],unknowns:['No evidence beyond the saved sweep'],quantity:null}]))}],
  scale:Object.fromEntries(VARIANT_CRITERIA.map(key=>[key,'Same shared scale'])),comparison:'One bounded variant',
  recommendation:{key:'one',reason:'Fits the exact snapshot'},searchLimits:['Saved sweep'],unknowns:[]});
async function paid(t:test.TestContext) {
  const f=await researchSetup(t,{adapter:'reply',prefix:'omg-4o2-paid-'}),project='p',runs=new Map<string,string>();
  await f.engine.execute({type:'create-project',project,title:'Paid variant authority'});
  const prepare=(selected=f.subject())=>{
    const context={history:[],readings:[]},draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!,question=f.store.get<Question>(f.v.plan.id)!;
    const old=runs.get(selected.planAnswer.hash),run=old?f.store.get<ResearchRun>(old)!:f.store.write<ResearchRun>({
      id:`research-run:${rand()}`,kind:'research-run',expected:0,value:{projectId:project,draftId:draft.id,environment:reference(f.environment),
        turns:0,limit:100,requestChars:0,owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runs.set(selected.planAnswer.hash,run.id);const number=run.value.turns+1;
    const input={projectId:project,kind:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,cursor:{run:run.id,turn:number,instruction:f.prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(f.environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input),invoke=()=>researchCall(f.environment.value.implementer,f.environment.value,f.prompt,context,undefined,
      {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const g={...f,prepare};
  for(const question of ['q-industry','q-market']) {
    const entry=await produce(g,undefined,question),packet=projectAttemptPacket(f.store,{project,planAnswer:f.v.planAnswer,planQuestionId:question,entries:[entry]});
    const reply={verdict:'supported',reasons:['Paid sweep'],return:null,novelty:{attempts:[{attempt:entry.attempt,reason:'Exact result'}],accepted:[],rejected:[],newContent:[],duplicates:[],
      noProgress:[{attempt:entry.attempt,reason:'No source'}],transition:null},methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[]}};
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
    const assessment=await assessAttempts(f.store,packet,v7ProgressBaseline(f.store,packet),f.environment,f.root);
    applyDiscoveryAssessment(f.store,project,reference(assessment));
  }
  const saved=produceVariantSnapshot(f.store,project).record;
  const modeSessions=new ProjectModeSessions(f.store),invite=ok(issueProjectModeInvitation(f.store,{project,mode:'questions',previous:null}));
  const exchanged=ok(modeSessions.exchange({project,invitation:invite.invitation}));
  const mode=setProjectMode(f.store,{project,mode:'questions',previous:null},modeSessions.authority(exchanged.bearer)).record;
  ok(modeSessions.revoke(exchanged.bearer));
  const subject:VariantSubject={contract:VARIANT_SUBJECT_CONTRACT,kind:'proposal',snapshot:reference(saved),mode:reference(mode),expectedSelection:null};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:generation()}));
  // Explicit transport fixture only for service calibration; the positive producer below uses the real snapshot.
  const calibration=f.store.write({id:'transport-fixture:owner-authority-calibration',kind:'transport-fixture',expected:0,value:{projectId:project}});
  await researchCall(f.environment.value.implementer,f.environment.value,'Calibrate generation',
    {variantSubject:{...subject,snapshot:reference(calibration)},history:[]},undefined,
    {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'variant-proposal'});
  const receipt=await runVariantSession(f.store,{projectId:project,variantSubject:subject,environment:f.environment,
    role:f.environment.value.implementer,prompt:'Propose variants from this exact paid sweep'});
  assert.equal(receipt.value.cursor,1);
  const sets=f.store.list<VariantSet>('discovery-variant-set');assert.equal(sets.length,1,'4B.1 publishes the real paid set');
  const set=sets[0]!,state=f.store.get(variantStateId(project,f.v.draft.id))!;
  const scope:VariantChoiceScope={action:VARIANT_OWNER_ACTION,projectId:project,draft:set.value.draft,set:reference(set),mode:reference(mode),
    operation:'initial',previous:null,expectedSelection:reference(state),outcome:{kind:'choose',member:set.value.members[0]!,reason:'The exact paid set fits the owner goal'}};
  return {...g,scope,set,mode,receipt};
}

const mint=(store:Store,scope:VariantChoiceScope)=>{
  const sessions=new VariantChoiceSessions(store),issued=ok(issueVariantChoiceInvitation(store,scope));
  const exchanged=ok(sessions.exchange({projectId:scope.projectId,invitation:issued.invitation}));
  return {sessions,issued,...exchanged,authority:sessions.authority(exchanged.bearer)!};
};
const modeOf=(store:Store,mode:'questions'|'bypass')=>{
  const previous=store.get('project-mode:p'),scope={project:'p',mode,previous:previous?reference(previous):null};
  const sessions=new ProjectModeSessions(store),issued=ok(issueProjectModeInvitation(store,scope));
  const login=ok(sessions.exchange({project:'p',invitation:issued.invitation}));
  return setProjectMode(store,scope,sessions.authority(login.bearer)).record;
};
const revised=(scope:VariantChoiceScope,act:ReturnType<typeof answerVariantChoice>,kind:'choose'|'reject_all'):VariantChoiceScope=>({
  ...scope,operation:'revise',previous:reference(act.decision),expectedSelection:reference(act.state),
  outcome:kind==='choose'?{kind,member:scope.outcome.kind==='choose'?scope.outcome.member:scope.set,reason:'Owner revised the exact choice'}
    :{kind,reason:'Owner rejects this exact set'}});

test('4O.2: real paid set and live authority commit initial choose and its exact state together',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),before=history(f.store),calls=f.wires().length;
  const act=answerVariantChoice(f.store,f.scope,m.authority);
  assert.equal(act.repeated,false);assert.equal(history(f.store).length,before.length+2);
  assert.deepEqual(act.decision.value.authority,{grant:m.issued.grant,session:m.session});
  assert.deepEqual(act.state.value.decision,reference(act.decision));assert.deepEqual(act.state.value.previous,f.scope.expectedSelection);
  assert.deepEqual(act.state.value.result,f.scope.set);assert.deepEqual(act.state.value.mode,f.scope.mode);
  assert.deepEqual(reference(f.store.get('project-mode:p')!),f.scope.mode);assert.equal(f.wires().length,calls);
  const proved=readVariantOwnerDecision(f.store,'p',reference(act.decision));
  assert.equal(proved.verification,'proven');assert.deepEqual(proved.decision,act.decision);assert.deepEqual(proved.state,act.state);
});

test('4O.2: owner reject_all, revise choose and revise reject_all preserve the complete exact chain',async t=>{
  const f=await paid(t),initial:VariantChoiceScope={...f.scope,outcome:{kind:'reject_all',reason:'Initial owner rejection'}};
  const first=answerVariantChoice(f.store,initial,mint(f.store,initial).authority);
  const choose:VariantChoiceScope={...revised(f.scope,first,'choose')};
  const next=answerVariantChoice(f.store,choose,mint(f.store,choose).authority);
  const reject=revised(f.scope,next,'reject_all'),last=answerVariantChoice(f.store,reject,mint(f.store,reject).authority);
  assert.deepEqual(next.decision.value.previous,reference(first.decision));assert.deepEqual(last.decision.value.previous,reference(next.decision));
  assert.equal(last.decision.value.outcome.kind,'reject_all');assert.deepEqual(last.state.value.decision,reference(last.decision));
  for(const act of [first,next,last]) assert.deepEqual(readVariantOwnerDecision(f.store,'p',reference(act.decision)).state,act.state);
});

test('4O.2: cold historical proof and old exact replay survive revoke, expiry and a newer owner choice without reactivation',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),first=answerVariantChoice(f.store,f.scope,m.authority);
  const scope=revised(f.scope,first,'reject_all'),last=answerVariantChoice(f.store,scope,mint(f.store,scope).authority);
  ok(m.sessions.revoke(m.bearer));modeOf(f.store,'bypass');
  const now=Date.now;t.mock.method(Date,'now',()=>now()+3_600_000);
  const cold=new Store(f.store.path);t.after(()=>cold.close());const before=history(cold),calls=f.wires().length;
  assert.deepEqual(readVariantOwnerDecision(cold,'p',reference(first.decision)).state,first.state);
  const repeat=answerVariantChoice(cold,f.scope,undefined);
  assert.equal(repeat.repeated,true);assert.deepEqual(repeat.decision,first.decision);assert.deepEqual(repeat.state,first.state);
  assert.deepEqual(reference(cold.get(last.state.id)!),reference(last.state));assert.deepEqual(history(cold),before);assert.equal(f.wires().length,calls);
});

test('4O.2: missing fields and authority masquerades cannot publish any owner act',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),before=history(f.store);
  for(const key of Object.keys(f.scope)) {const request={...f.scope} as Record<string,unknown>;delete request[key];refuses(()=>answerVariantChoice(f.store,request,m.authority));}
  for(const authority of [undefined,null,'owner',{actor:'owner'},m.session,{exercise:()=>({ok:true,value:{session:m.session}})}])
    refuses(()=>answerVariantChoice(f.store,f.scope,authority),'owner_authority_invalid');
  for(const request of [{...f.scope,ready:true},{...f.scope,outcome:{...f.scope.outcome,reason:'Changed reason'}},
    {...f.scope,expectedSelection:null},{...f.scope,mode:reference(f.set)}]) refuses(()=>answerVariantChoice(f.store,request,m.authority));
  assert.deepEqual(history(f.store),before);
});

test('4O.2: initial is questions-only and revise must name the actual previous owner selection',async t=>{
  const f=await paid(t),bypass=modeOf(f.store,'bypass'),scope={...f.scope,mode:reference(bypass)};
  const m=mint(f.store,scope),before=history(f.store);
  refuses(()=>answerVariantChoice(f.store,scope,m.authority),'discovery_variant_mode_mismatch');assert.deepEqual(history(f.store),before);
  const mode=modeOf(f.store,'questions'),initial={...f.scope,mode:reference(mode)};
  const first=answerVariantChoice(f.store,initial,mint(f.store,initial).authority);
  const wrong={...revised(initial,first,'reject_all'),previous:reference(f.set)},bad=mint(f.store,wrong),snapshot=history(f.store);
  refuses(()=>answerVariantChoice(f.store,wrong,bad.authority),'discovery_variant_stale');assert.deepEqual(history(f.store),snapshot);
});

for(const move of ['revoke','mode','selection'] as const) test(`4O.2: a second Store moving ${move} before commit refuses the entire decision/state batch`,async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),other=new Store(f.store.path);t.after(()=>other.close());
  const write=f.store.writeMany.bind(f.store);let intervened=false,afterMove:ReturnType<typeof history>=[];
  f.store.writeMany=((writes,guards)=>{
    if(!intervened && writes.some(row=>row.kind==='discovery-variant-owner-decision')) {
      intervened=true;
      if(move==='revoke') ok(m.sessions.revoke(m.bearer,other));
      else if(move==='mode') modeOf(other,'bypass');
      else {const scope:VariantChoiceScope={...f.scope,outcome:{kind:'reject_all',reason:'Concurrent owner'}};
        answerVariantChoice(other,scope,mint(other,scope).authority);}
      afterMove=history(other);
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  refuses(()=>answerVariantChoice(f.store,f.scope,m.authority));assert.equal(intervened,true);assert.deepEqual(history(f.store),afterMove);
  assert.equal(f.store.list('discovery-variant-owner-decision').length,move==='selection'?1:0);
  f.store.writeMany=write;
  const calls=f.wires().length;
  let retry:VariantChoiceScope=f.scope;
  if(move==='mode') retry={...f.scope,mode:reference(modeOf(f.store,'questions'))};
  if(move==='selection') {
    const winner=f.store.list<import('../src/discovery/variant-decision.js').VariantOwnerDecision>('discovery-variant-owner-decision')[0]!;
    retry={...f.scope,operation:'revise',previous:reference(winner),expectedSelection:reference(f.store.get(variantStateId('p',f.scope.draft.id))!)};
  }
  const recovered=answerVariantChoice(f.store,retry,mint(f.store,retry).authority);
  assert.equal(recovered.repeated,false);assert.equal(recovered.decision.value.outcome.kind,'choose');assert.equal(f.wires().length,calls);
});

test('4O.2: stale exact selection and expired session refuse new acts without writing',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),first=answerVariantChoice(f.store,f.scope,m.authority);
  const stale:VariantChoiceScope={...f.scope,outcome:{kind:'reject_all',reason:'Stale owner request'}},s=mint(f.store,stale),before=history(f.store);
  refuses(()=>answerVariantChoice(f.store,stale,s.authority));assert.deepEqual(history(f.store),before);
  const scope=revised(f.scope,first,'reject_all'),expired=mint(f.store,scope),saved=history(f.store),now=Date.now;
  t.mock.method(Date,'now',()=>now()+3_600_000);
  refuses(()=>answerVariantChoice(f.store,scope,expired.authority),'owner_session_expired');assert.deepEqual(history(f.store),saved);
});

test('4O.2: incomplete decision/state or authority history never proves a structural owner lookalike',async t=>{
  const f=await paid(t),m=mint(f.store,f.scope),act=answerVariantChoice(f.store,f.scope,m.authority),before=history(f.store);
  // Explicit negative reader corruption: hide one saved component of an otherwise real act.
  const get=f.store.get.bind(f.store);
  for(const ref of [reference(act.state),m.session,m.issued.grant]) {
    f.store.get=((id,revision)=>id===ref.id && revision===ref.revision?null:get(id,revision)) as typeof f.store.get;
    refuses(()=>readVariantOwnerDecision(f.store,'p',reference(act.decision)));
  }
  f.store.get=get;assert.deepEqual(history(f.store),before);
  refuses(()=>readVariantOwnerDecision(f.store,'foreign',reference(act.decision)));
  for(const key of Object.keys(act.decision.value)) {
    const value={...act.decision.value} as Record<string,unknown>;delete value[key];
    const row=f.store.write({id:`negative-owner:${key}`,kind:'discovery-variant-owner-decision',expected:0,value});
    const snapshot=history(f.store);refuses(()=>readVariantOwnerDecision(f.store,'p',reference(row)));assert.deepEqual(history(f.store),snapshot);
  }
});

const money=(store:Store)=>({calls:store.list('model-call').flatMap(row=>store.history(row.id)),
  ledger:store.list('research-budget-ledger').flatMap(row=>store.history(row.id))});
async function modelReady(f:Awaited<ReturnType<typeof paid>>,outcome:'choose'|'reject_all') {
  const mode=modeOf(f.store,'bypass'),reply=outcome==='choose'?{action:'choose',key:'one',reason:'Real paid model choice'}
    :{action:'reject_all',reason:'Real paid model rejection'};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  // Transport-only service calibration, separate from the real set and from every positive decision/application.
  const cal=reference(f.store.write({id:'transport-fixture:owner-decision-calibration',kind:'transport-fixture',expected:0,value:{projectId:'p'}}));
  for(const role of [f.environment.value.implementer,f.environment.value.reviewer])
    await researchCall(role,f.environment.value,'Calibrate decision',{variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,
      kind:'decision',set:cal,mode:reference(mode),expectedSelection:null},history:[]},undefined,
      {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'variant-decision'});
  const input:VariantSessionInput={projectId:'p',environment:f.environment,role:f.environment.value.implementer,
    prompt:'Choose from the exact paid set',variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,kind:'decision',set:reference(f.set),
      mode:reference(mode),expectedSelection:reference(f.store.get(variantStateId('p',f.scope.draft.id))!)}};
  const pay=async()=>{
    const prepared=prepareVariantSession(f.store,input),v=prepared.intent.value;
    await researchCall(v.role,v.dispatch,v.cursor.prompt,v.cursor.context,undefined,{store:f.store,draftId:v.draft.id,
      questionId:v.question.id,purpose:v.kind,consumerIntent:reference(prepared.intent),session:v.owner});
    return f.store.get<ResearchConsumerIntent>(prepared.intent.id)!;
  };
  return {mode,input,pay};
}

for(const ownerOutcome of ['choose','reject_all'] as const) test(`4O.2: real bypass model -> owner override ${ownerOutcome} -> revise; cold replay and mode change buy no other choice`,async t=>{
  const f=await paid(t),b=await modelReady(f,ownerOutcome==='choose'?'reject_all':'choose');
  const receipt=await runVariantSession(f.store,b.input),model=f.store.list<import('../src/discovery/variant-decision.js').VariantModelDecision>('discovery-variant-model-decision')[0]!;
  const proved=readVariantModelDecision(f.store,'p',reference(model));assert.ok(proved.state);
  const scope:VariantChoiceScope={...f.scope,operation:'override',previous:reference(model),mode:reference(b.mode),expectedSelection:proved.state!,
    outcome:ownerOutcome==='choose'?f.scope.outcome:{kind:'reject_all',reason:'Owner overrides this model choice'}};
  const m=mint(f.store,scope),before=history(f.store),accounting=money(f.store),sent=f.wires().length;
  const act=answerVariantChoice(f.store,scope,m.authority);
  assert.equal(act.repeated,false);assert.equal(history(f.store).length,before.length+2);assert.deepEqual(act.decision.value.previous,reference(model));
  assert.deepEqual(reference(f.store.get('project-mode:p')!),reference(b.mode));assert.deepEqual(money(f.store),accounting);assert.equal(f.wires().length,sent);
  const nextScope=revised(f.scope,act,ownerOutcome==='choose'?'reject_all':'choose');nextScope.mode=reference(b.mode);
  const revisedAct=answerVariantChoice(f.store,nextScope,mint(f.store,nextScope).authority);ok(m.sessions.revoke(m.bearer));
  const changed=modeOf(f.store,'bypass'),cold=new Store(f.store.path);t.after(()=>cold.close());
  const snapshot=history(cold),paidBefore=money(cold);
  for(const saved of [act,revisedAct]) assert.deepEqual(readVariantOwnerDecision(cold,'p',reference(saved.decision)).state,saved.state);
  assert.equal(answerVariantChoice(cold,scope,undefined).repeated,true);
  assert.deepEqual(await runVariantSession(cold,b.input),receipt,'the original paid model result stays historically available');
  for(const role of [f.environment.value.implementer,f.environment.value.reviewer]) {
    const input:VariantSessionInput={...b.input,role,variantSubject:{...b.input.variantSubject,mode:reference(changed),expectedSelection:reference(revisedAct.state)}};
    refuses(()=>prepareVariantSession(cold,input),'discovery_variant_decision_exists');
  }
  assert.deepEqual(history(cold),snapshot);assert.deepEqual(money(cold),paidBefore);assert.equal(f.wires().length,sent);
  assert.deepEqual(reference(cold.get(revisedAct.state.id)!),reference(revisedAct.state));
});

for(const applyFirst of [false,true]) test(`4O.2: already paid model ${applyFirst?'publishes stale before':'publishes after'} the questions owner act; paid history survives and never overwrites owner`,async t=>{
  const f=await paid(t),b=await modelReady(f,'choose'),running=await b.pay();
  const questions=modeOf(f.store,'questions'),scope:VariantChoiceScope={...f.scope,mode:reference(questions)};
  const cold=new Store(f.store.path);t.after(()=>cold.close());const sent=f.wires().length,accounting=money(cold);
  if(applyFirst) applyVariantSession(cold,'p',reference(running));
  const act=answerVariantChoice(f.store,scope,mint(f.store,scope).authority);
  if(!applyFirst) applyVariantSession(cold,'p',reference(running));
  const model=cold.list('discovery-variant-model-decision')[0]!;
  const proof=readVariantModelDecision(cold,'p',reference(model));assert.equal(proof.state,null);
  assert.deepEqual(reference(cold.get(act.state.id)!),reference(act.state));assert.deepEqual(money(cold),accounting);assert.equal(f.wires().length,sent);
  assert.deepEqual(readVariantOwnerDecision(cold,'p',reference(act.decision)).state,act.state);
  const before=history(cold);assert.equal(answerVariantChoice(cold,scope,undefined).repeated,true);
  await runVariantSession(cold,b.input);assert.deepEqual(history(cold),before);assert.equal(f.wires().length,sent);
  const bypass=modeOf(cold,'bypass');
  const invalidOverride:VariantChoiceScope={...scope,operation:'override',previous:reference(model),expectedSelection:reference(act.state),mode:reference(bypass)};
  const login=mint(cold,invalidOverride),snapshot=history(cold);
  refuses(()=>answerVariantChoice(cold,invalidOverride,login.authority),'discovery_variant_stale');assert.deepEqual(history(cold),snapshot);
  refuses(()=>prepareVariantSession(cold,{...b.input,variantSubject:{...b.input.variantSubject,mode:reference(bypass),expectedSelection:reference(act.state)}}),
    'discovery_variant_decision_exists');assert.deepEqual(history(cold),snapshot);
});

test('4O.2: owner-like or structural model previous cannot authorize override',async t=>{
  const f=await paid(t),initial=answerVariantChoice(f.store,f.scope,mint(f.store,f.scope).authority),mode=modeOf(f.store,'bypass');
  const ownerLike:VariantChoiceScope={...f.scope,mode:reference(mode),operation:'override',previous:reference(initial.decision),expectedSelection:reference(initial.state)};
  const m=mint(f.store,ownerLike),before=history(f.store);
  refuses(()=>answerVariantChoice(f.store,ownerLike,m.authority));assert.deepEqual(history(f.store),before);
  // This is a deliberate negative structural record; it is never used as a positive model producer.
  const fake=f.store.write({id:'negative-model-decision',kind:'discovery-variant-model-decision',expected:0,value:{set:f.scope.set,actor:'model'}});
  const malformed={...ownerLike,previous:reference(fake)},m2=mint(f.store,malformed),snapshot=history(f.store);
  refuses(()=>answerVariantChoice(f.store,malformed,m2.authority));assert.deepEqual(history(f.store),snapshot);
});
