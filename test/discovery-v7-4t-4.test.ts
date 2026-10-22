import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hashJson } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { EngineError } from '../src/errors.js';
import { Store, type Write } from '../src/storage/store.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { budgetUsage, type BudgetSegment } from '../src/runtime/research-budget.js';
import { variantStateId } from '../src/discovery/variant-decision.js';
import { processStart } from '../src/runtime/process-identity.js';
import type { DiscoveryDraft, Question } from '../src/discovery/discovery.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { prepareResearchConsumerIntent, readResearchConsumerExecution, readResearchConsumerIntent,
  type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import { assessAttempts } from '../src/discovery/research-assessment.js';
import { projectAttemptPacket } from '../src/discovery/v7-attempt-assessment.js';
import { applyDiscoveryAssessment, v7ProgressBaseline } from '../src/discovery/v7-progress.js';
import { produceVariantSnapshot } from '../src/discovery/variant-snapshot.js';
import { prepareVariantSession, runVariantSession, applyVariantSession, readVariantExecutionSession, variantExecutionSessionId } from '../src/discovery/variant-session.js';
import { VARIANT_SUBJECT_CONTRACT, VARIANT_CRITERIA, type VariantSubject, type VariantExecutionSession } from '../src/discovery/discovery-variants.js';
import { variantTransportFields, variantTransportGuards } from '../src/discovery/continuation-packet.js';
import { researchSetup, produce, rand } from './discovery-v7-fixture.js';

const snapshot=(store:Store)=>store.list().flatMap(row=>store.history(row.id));
const code=(expected:string)=>(error:unknown)=>error instanceof EngineError && error.code===expected;
const generation=()=>({action:'variants',variants:[{key:'one',title:'One bounded variant',proposal:{scope:'common'},
  criteria:Object.fromEntries(VARIANT_CRITERIA.map(key=>[key,{conclusion:'Bounded by the actual sweep',grounds:[],assumptions:[],unknowns:['No additional evidence beyond the saved sweep'],quantity:null}]))}],
  scale:Object.fromEntries(VARIANT_CRITERIA.map(key=>[key,'Same shared scale'])),comparison:'One bounded variant',
  recommendation:{key:'one',reason:'Fits the snapshot'},searchLimits:['Only saved sweep'],unknowns:[]});
async function setup(t:test.TestContext) {
  const f=await researchSetup(t,{adapter:'reply',prefix:'omg-4t4-'}),project='p';
  // Each edition has its own execution owner; the stage budget remains shared across them.
  const runs=new Map<string,string>();
  const prepare=(selected=f.subject())=>{
    const context={history:[],readings:[]};
    const draft=f.store.get<DiscoveryDraft>(f.v.draft.id)!,question=f.store.get<Question>(f.v.plan.id)!;
    const runId=runs.get(selected.planAnswer.hash);
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(f.environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runs.set(selected.planAnswer.hash,run.id); const number=run.value.turns+1;
    const input={projectId:project,kind:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:f.environment.value.implementer,dispatch:f.environment.value,profile:null,
      cursor:{run:run.id,turn:number,instruction:f.prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(f.environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=()=>researchCall(f.environment.value.implementer,f.environment.value,f.prompt,context,undefined,
      {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  const g={...f,prepare};
  for(const question of ['q-industry','q-market']) {
    const entry=await produce(g,undefined,question),packet=projectAttemptPacket(f.store,{project,planAnswer:f.v.planAnswer,planQuestionId:question,entries:[entry]});
    const reply={verdict:'supported',reasons:['Real paid assessment'],return:null,novelty:{attempts:[{attempt:entry.attempt,reason:'Exact result'}],
      accepted:[],rejected:[],newContent:[],duplicates:[],noProgress:[{attempt:entry.attempt,reason:'No source'}],transition:null},
      methodology:{contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[]}};
    writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
    const paid=await assessAttempts(f.store,packet,v7ProgressBaseline(f.store,packet),f.environment,f.root);
    applyDiscoveryAssessment(f.store,project,reference(paid));
  }
  const saved=produceVariantSnapshot(f.store,project).record;
  // Explicit transport/control fixtures: no product set or owner/mode authority is claimed.
  const mode=f.store.write({id:'mode-fixture:p',kind:'mode-fixture',expected:0,value:{projectId:project,mode:'questions'}});
  const cal=f.store.write({id:'transport-fixture:calibration',kind:'transport-fixture',expected:0,value:{projectId:project}});
  const subject:VariantSubject={contract:VARIANT_SUBJECT_CONTRACT,kind:'proposal',snapshot:reference(cal),mode:reference(mode),expectedSelection:null};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:generation()}));
  await researchCall(f.environment.value.implementer,f.environment.value,'Calibrate variants',{variantSubject:subject,history:[]},undefined,
    {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'variant-proposal'});
  const input={projectId:project,variantSubject:{...subject,snapshot:reference(saved)},environment:f.environment,
    role:f.environment.value.implementer,prompt:'Propose variants from this exact saved sweep'};
  return {...g,input,mode,saved};
}
type Setup=Awaited<ReturnType<typeof setup>>;
async function pay(f:Setup,store=f.store) {
  const prepared=prepareVariantSession(store,f.input),v=prepared.intent.value;
  await researchCall(v.role,v.dispatch,v.cursor.prompt,v.cursor.context,undefined,
    {store,draftId:v.draft.id,questionId:v.question.id,purpose:v.kind,consumerIntent:reference(prepared.intent),session:v.owner});
  return store.get<ResearchConsumerIntent>(prepared.intent.id)!;
}

test('4T.4: real snapshot -> managed intent/call/output; cold repeated publication does not pay or change K/N',async t=>{
  const f=await setup(t),calls=f.wires().length,attempts=f.store.list('research-attempt'),states=f.store.list('v7-progress-state');
  const result=await runVariantSession(f.store,f.input);assert.equal(result.value.cursor,1);assert.ok(result.value.result);
  assert.equal(f.wires().length,calls+1);assert.deepEqual(f.store.list('research-attempt'),attempts);assert.deepEqual(f.store.list('v7-progress-state'),states);
  const origin=readResearchConsumerIntent(f.store,result.value.result!.intent);assert.equal(origin.value.state,'running');
  assert.deepEqual(origin.value.cursor.resultCapacity.forms.map((form:any)=>form.kind),['variants','no_variants']);
  assert.deepEqual(origin.value.cursor.resultCapacity.bindings.variantSubject,f.input.variantSubject);
  const execution=readResearchConsumerExecution(f.store,'p',reference(origin));assert.equal(execution.kind,'response');
  assert.equal(execution.intent.value.state,'applied');assert.deepEqual(execution.intent.value.outputs,[reference(result)]);
  const before=snapshot(f.store),cold=f.open();
  assert.deepEqual(readVariantExecutionSession(cold,'p',reference(result)),result);
  assert.deepEqual(await runVariantSession(cold,f.input),result);assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls+1);
});

test('4T.4: a session-only cut resumes through the common preparer and buys only one result',async t=>{
  const f=await setup(t),calls=f.wires().length,write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes:Write[],guards:any[])=>{const saved=write(writes,guards);
    if(!cut && writes.some(w=>w.kind==='discovery-variant-session'&&w.expected===0)){cut=true;throw new EngineError('fixture_cut','after session');}return saved;}) as typeof f.store.writeMany;
  await assert.rejects(runVariantSession(f.store,f.input),code('fixture_cut'));assert.equal(f.wires().length,calls);
  f.store.writeMany=write;
  const result=await runVariantSession(f.open(),f.input);assert.equal(result.value.cursor,1);assert.equal(f.wires().length,calls+1);
});

test('4T.4: a paid cut recovers after mode/state changed, preserving the original choice and paid basis',async t=>{
  const f=await setup(t),calls=f.wires().length,intent=await pay(f);assert.equal(f.wires().length,calls+1);
  f.store.write({id:f.mode.id,kind:f.mode.kind,expected:f.mode.revision,value:{projectId:'p',mode:'bypass'}});
  // Negative/current-state fixture only: a concurrent selection must not be overwritten by an execution receipt.
  const state=f.store.write({id:variantStateId('p',f.v.draft.id),kind:'state-fixture',expected:0,value:{projectId:'p',selected:'a newer choice'}});
  const result=await runVariantSession(f.open(),f.input);assert.equal(result.value.cursor,1);assert.equal(f.wires().length,calls+1);
  assert.deepEqual(f.store.get(state.id),state);assert.deepEqual(result.value.variantSubject,f.input.variantSubject);
  assert.deepEqual(result.value.result!.intent,reference(intent));
  const before=snapshot(f.store);await runVariantSession(f.open(),f.input);assert.deepEqual(snapshot(f.store),before);
});

test('4T.4: a failed atomic application leaves the paid response recoverable without a second send',async t=>{
  const f=await setup(t),intent=await pay(f),calls=f.wires().length,write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes:Write[],guards:any[])=>{if(!cut&&writes.some(w=>w.kind==='discovery-variant-session'&&w.expected===1)){
    cut=true;throw new EngineError('revision_conflict','application fixture race');}return write(writes,guards);}) as typeof f.store.writeMany;
  assert.throws(()=>applyVariantSession(f.store,'p',reference(intent)),code('revision_conflict'));f.store.writeMany=write;
  assert.equal(f.store.get<ResearchConsumerIntent>(intent.id)!.value.state,'running');
  const result=await runVariantSession(f.open(),f.input);assert.equal(result.value.cursor,1);assert.equal(f.wires().length,calls);
});

for(const kind of ['missing','foreign','structural'] as const)test(`4T.4: decision with ${kind} set has no new admission or side effects`,async t=>{
  const f=await setup(t),basis:Ref=kind==='missing'?{id:'variant-set:missing',revision:1,hash:f.saved.hash}:
    reference(f.store.write({id:`transport-fixture:set:${kind}`,kind:'transport-fixture',expected:0,value:{projectId:kind==='foreign'?'other':'p'}}));
  const before=snapshot(f.store),calls=f.wires().length;
  await assert.rejects(runVariantSession(f.store,{...f.input,variantSubject:{contract:VARIANT_SUBJECT_CONTRACT,kind:'decision',set:basis,
    mode:reference(f.mode),expectedSelection:null}}),code('discovery_variant_set_not_ready'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});


test('4T.4: a dead process after reservation preserves its single physical claim on cold entry',async t=>{
  const f=await setup(t),calls=f.wires().length;
  const source=`import {Store} from ${JSON.stringify(new URL('../src/storage/store.js',import.meta.url).href)};
import {runVariantSession} from ${JSON.stringify(new URL('../src/discovery/variant-session.js',import.meta.url).href)};
const store=new Store(process.argv[1]),input=JSON.parse(process.argv[2]),write=store.writeMany.bind(store);
store.writeMany=(writes,guards)=>{const saved=write(writes,guards);
 if(writes.some(w=>w.kind==='model-call'&&w.expected===0))process.exit(71);return saved;};
await runVariantSession(store,input);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source,f.path,JSON.stringify(f.input)],{encoding:'utf8',timeout:20000});
  assert.equal(child.status,71,child.stderr);assert.equal(f.wires().length,calls);
  const claimed=f.store.list<any>('model-call').filter(row=>row.value.purpose==='variant-proposal'&&row.id.startsWith('model-call:consumer:v1:'));
  assert.equal(claimed.length,1);assert.equal(claimed[0]!.value.status,'running');
  await assert.rejects(runVariantSession(f.open(),f.input),code('research_consumer_execution_refused'));
  const before=snapshot(f.store);
  await assert.rejects(runVariantSession(f.open(),f.input),code('research_consumer_execution_refused'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
  assert.equal(f.store.list<any>('model-call').filter(row=>row.id===claimed[0]!.id).length,1);
});

test('4T.4: actual overrun retains one paid response for free publication and closes new sends',async t=>{
  const f=await setup(t),calls=f.wires().length;
  writeFileSync(f.settings,JSON.stringify({tokens:80_000_000,reply:generation()}));
  const intent=await pay(f),segment=f.store.list<BudgetSegment>('research-budget').find(row=>row.value.projectId==='p')!;
  assert.ok(budgetUsage(f.store,segment).measured>segment.value.limit);
  const ledger=f.store.list('research-budget-ledger'),allCalls=f.store.list('model-call');
  const result=await runVariantSession(f.open(),f.input);assert.deepEqual(result.value.result!.intent,reference(intent));
  assert.equal(f.wires().length,calls+1);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.deepEqual(f.store.list('model-call'),allCalls);
  const newer=f.store.write({id:f.mode.id,kind:f.mode.kind,expected:f.mode.revision,value:{projectId:'p',mode:'questions'}});
  await assert.rejects(runVariantSession(f.open(),{...f.input,variantSubject:{...f.input.variantSubject,mode:reference(newer)}}),code('discovery_budget_overrun'));
  assert.equal(f.wires().length,calls+1);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.deepEqual(f.store.list('model-call'),allCalls);
});

test('4T.4: a second Store moving accounting at terminal commit cannot discard paid bytes',async t=>{
  const f=await setup(t),calls=f.wires().length,other=f.open(),write=f.store.writeMany.bind(f.store);let raced=false;
  f.store.writeMany=((writes:Write[],guards:any[])=>{
    if(!raced && writes.some(w=>w.kind==='model-response')&&writes.some(w=>w.kind==='model-call'&&(w.value as any).status==='succeeded')) {
      raced=true;const ledger=other.list('research-budget-ledger')[0]!;
      other.write({id:ledger.id,kind:ledger.kind,expected:ledger.revision,value:ledger.value});
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  const result=await runVariantSession(f.store,f.input);f.store.writeMany=write;
  assert.ok(raced);assert.equal(result.value.cursor,1);assert.equal(f.wires().length,calls+1);
  const before=snapshot(f.store);assert.deepEqual(await runVariantSession(f.open(),f.input),result);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls+1);
});

for(const race of ['mode','absent selection'] as const)test(`4T.4: ${race} changing before reservation atomically refuses an unpaid send`,async t=>{
  const f=await setup(t),calls=f.wires().length,other=f.open(),write=f.store.writeMany.bind(f.store);let raced=false;
  prepareVariantSession(f.store,f.input);
  const allCalls=f.store.list('model-call'),ledger=f.store.list('research-budget-ledger');
  f.store.writeMany=((writes:Write[],guards:any[])=>{
    if(!raced&&writes.some(w=>w.kind==='model-call'&&w.expected===0)) {
      raced=true;
      if(race==='mode')other.write({id:f.mode.id,kind:f.mode.kind,expected:f.mode.revision,value:{projectId:'p',mode:'bypass'}});
      else other.write({id:variantStateId('p',f.v.draft.id),kind:'state-fixture',expected:0,value:{projectId:'p',selection:'concurrent'}});
    }
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(runVariantSession(f.store,f.input),code('input_stale'));f.store.writeMany=write;
  assert.ok(raced);assert.equal(f.wires().length,calls);assert.deepEqual(f.store.list('model-call'),allCalls);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  await assert.rejects(runVariantSession(f.open(),f.input),code('input_stale'));
  assert.equal(f.wires().length,calls);assert.deepEqual(f.store.list('model-call'),allCalls);
});

for(const field of ['projectId','variantSubject','environment','role','prompt'] as const)test(`4T.4: missing ${field} refuses before preparation or payment`,async t=>{
  const f=await setup(t),input:any={...f.input};delete input[field];
  const before=snapshot(f.store),calls=f.wires().length;
  await assert.rejects(runVariantSession(f.store,input),error=>error instanceof EngineError&&
    ['discovery_variant_session_invalid','discovery_variant_subject_invalid'].includes(error.code));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});

test('4T.4: a structural execution receipt cannot masquerade as a paid managed application',async t=>{
  const f=await setup(t),prepared=prepareVariantSession(f.store,f.input),calls=f.wires().length;
  const fake=f.store.write({id:prepared.session.id,kind:prepared.session.kind,expected:1,value:{...prepared.session.value,cursor:1,
    result:{intent:reference(prepared.intent),call:reference(f.mode),response:reference(f.saved)}}});
  const before=snapshot(f.store);
  assert.throws(()=>readVariantExecutionSession(f.open(),'p',reference(fake)),code('research_consumer_intent_invalid'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});


test('4T.4: no_variants keeps its exact paid negative result in the same execution lifecycle',async t=>{
  const f=await setup(t),calls=f.wires().length;
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'no_variants',
    reasons:[{code:'bounded_none',message:'This saved sweep supports no variant',grounds:[reference(f.saved)]}],searchLimits:['Exact saved sweep'],unknowns:[]}}));
  const result=await runVariantSession(f.store,f.input),paid=readResearchConsumerExecution(f.store,'p',result.value.result!.intent);
  assert.equal(paid.kind,'response');if(paid.kind==='response')assert.equal((paid.payload as any).action,'no_variants');
  assert.equal(f.wires().length,calls+1);const before=snapshot(f.store);
  assert.deepEqual(await runVariantSession(f.open(),f.input),result);assert.deepEqual(snapshot(f.store),before);
  assert.equal(f.wires().length,calls+1);
});

for(const masquerade of ['missing','foreign'] as const)test(`4T.4: ${masquerade} snapshot cannot enter the real proposal producer`,async t=>{
  const f=await setup(t),calls=f.wires().length;
  const basis=masquerade==='missing'?{...reference(f.saved),id:'discovery-variant-snapshot:missing'}:
    reference(f.store.write({id:'transport-fixture:foreign-snapshot',kind:f.saved.kind,expected:0,
      value:{...f.saved.value,projectId:'other'}}));
  const before=snapshot(f.store);
  await assert.rejects(runVariantSession(f.store,{...f.input,variantSubject:{...f.input.variantSubject,snapshot:basis}}),
    error=>error instanceof EngineError&&['discovery_variant_invalid','discovery_variant_basis_invalid'].includes(error.code));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});


test('4T.4: a caller cannot remove the absent-state guard from the common variant preparer',async t=>{
  const f=await setup(t),prepared=prepareVariantSession(f.store,f.input),before=snapshot(f.store),calls=f.wires().length;
  assert.throws(()=>prepareResearchConsumerIntent(f.store,{...prepared.intent.value,
    guards:prepared.intent.value.guards.filter(guard=>!('absent' in guard))}),code('research_consumer_intent_invalid'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});


for(const field of ['actor','projectId','purpose','draftRef','questionRef','variantSubject'] as const)
  test(`4T.4: missing context ${field} cannot bypass the common preparer binding`,async t=>{
    const f=await setup(t),prepared=prepareVariantSession(f.store,f.input),before=snapshot(f.store),calls=f.wires().length;
    const context={...prepared.intent.value.cursor.context};delete context[field];
    assert.throws(()=>prepareResearchConsumerIntent(f.store,{...prepared.intent.value,
      cursor:{...prepared.intent.value.cursor,context}}),code('research_consumer_intent_invalid'));
    assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
  });


test('4T.4: an oversized complete variant result keeps its paid evidence and cannot publish a receipt',async t=>{
  const f=await setup(t),calls=f.wires().length,reply=generation();reply.comparison='x'.repeat(400000);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  await assert.rejects(runVariantSession(f.store,f.input),code('research_result_capacity'));
  assert.equal(f.wires().length,calls+1);const before=snapshot(f.store);
  await assert.rejects(runVariantSession(f.open(),f.input),code('research_result_capacity'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls+1);
  assert.ok(f.store.list<any>('discovery-variant-session').every(row=>row.value.cursor===0));
});


for(const first of ['direct','managed'] as const)test(`4T.4: ${first} execution excludes the other transport without a second payment`,async t=>{
  const f=await setup(t),prepared=prepareVariantSession(f.store,f.input),v=prepared.intent.value,calls=f.wires().length;
  const direct=()=>researchCall(v.role,v.dispatch,v.cursor.prompt,v.cursor.context,undefined,
    {store:f.store,draftId:v.draft.id,questionId:v.question.id,purpose:v.kind});
  if(first==='direct')await direct();else await runVariantSession(f.store,f.input);
  assert.equal(f.wires().length,calls+1);const before=snapshot(f.store);
  if(first==='direct')await assert.rejects(runVariantSession(f.open(),f.input),code('discovery_variant_managed'));
  else await assert.rejects(direct(),code('discovery_variant_managed'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls+1);
});


test('4T.4: the general managed decision door cannot reserve against a merely structural set',async t=>{
  const f=await setup(t),prototype=prepareVariantSession(f.store,f.input);
  const subject:VariantSubject={contract:VARIANT_SUBJECT_CONTRACT,kind:'decision',set:reference(f.saved),mode:reference(f.mode),expectedSelection:null};
  // Negative transport fixtures only: this is deliberately NOT a set producer or a positive paid decision.
  const cal=f.store.write({id:'transport-fixture:decision-calibration',kind:'transport-fixture',expected:0,value:{projectId:'p'}});
  await researchCall(f.environment.value.implementer,f.environment.value,'Calibrate decision transport',
    {variantSubject:{...subject,set:reference(cal)},history:[]},undefined,
    {store:f.store,draftId:f.calibration.draft.id,questionId:f.calibration.question.id,purpose:'variant-decision'});
  const initial:VariantExecutionSession={...prototype.session.value,variantSubject:subject,purpose:'variant-decision'};
  const owner=f.store.write({id:variantExecutionSessionId(initial),kind:'discovery-variant-session',expected:0,value:initial});
  const v=prototype.intent.value;
  const context={...variantTransportFields('p',v.draft,v.question,'variant-decision',v.role.actor,subject),history:[]};
  const intent=prepareResearchConsumerIntent(f.store,{...v,kind:'variant-decision',key:owner.id,owner:reference(owner),
    cursor:{sessionId:owner.id,offset:0,variantSubject:subject,prompt:'Decide on this set',context},basis:[subject.set,subject.mode],
    guards:uniqueTransactionGuards([reference(owner),v.draft,v.question,reference(f.environment),...variantTransportGuards('p',v.draft.id,subject)])});
  assert.deepEqual(readVariantExecutionSession(f.store,'p',reference(owner)),owner);
  const before=snapshot(f.store),calls=f.wires().length;
  await assert.rejects(researchCall(v.role,v.dispatch,intent.value.cursor.prompt,context,undefined,
    {store:f.store,draftId:v.draft.id,questionId:v.question.id,purpose:'variant-decision',consumerIntent:reference(intent),session:reference(owner)}),
    code('discovery_variant_set_not_ready'));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,calls);
});
