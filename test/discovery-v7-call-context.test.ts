import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { V7_STAGE_TOKEN_CEILING } from '../src/discovery/v7-contracts.js';
import { type Revision } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { researchSetup, rand, questionOf, validPlan, type PlanQuestion, type DiscoveryFixture as Fixture } from './discovery-v7-fixture.js';
import { answerDiscoveryFixture } from './product-fixture.js';
import { researchCall, prepareResearchEnvelope } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution,
  completeResearchAttemptTurn, type ResearchConsumerIntent } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { recordV7Attempt } from '../src/discovery/v7-attempts.js';
import { attemptEndOfAction } from '../src/discovery/v7-managed-attempt.js';
import { invocationProgress } from '../src/discovery/invocation-progress.js';
import { workingContext } from '../src/discovery/working-context.js';
import { REQUEST_MANIFEST_CONTRACT, readRequestWire } from '../src/discovery/request-parts.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { budgetUsage, type BudgetSegment } from '../src/runtime/research-budget.js';
import { stageBudgetSegmentId } from '../src/discovery/stage-token-budget.js';

/** The next lawful plan edition: reopen and accept again. */
function acceptNextPlanEdition(f: Fixture, project: string, draft: Revision<DiscoveryDraft>, frameRef: Ref,
  previous: Ref, questions: PlanQuestion[]) {
  const planQ = questionOf(f.store, f.store.get<DiscoveryDraft>(draft.id)!, "plan");
  f.discovery.reopen(planQ.id, planQ.revision);
  const reopened = f.store.get<Question>(planQ.id)!;
  const src = f.discovery.evidence.document(project, `basis-${rand()}`, `Source ${rand()}`, "text/plain", 0);
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!, reopened,
    validPlan(frameRef, questions, 2, previous), src);
  const plan = f.store.get<Question>(planQ.id)!;
  return { draft: f.store.get<DiscoveryDraft>(draft.id)!, plan, planAnswer: plan.value.answer! };
}

async function setup(t: test.TestContext) {
  const f = await researchSetup(t, { adapter: 'fixed', prefix: 'omg-dr3a3k-', timeoutMs: 5000, calibrate: ['analyst'] }), { v, project, environment, subject, prompt } = f;
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:1,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    const input={projectId:project,kind:'analyst' as const,key:run.id,owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:1,instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,intent,input,invoke,question,draft,selected,context};
  };
  return {...f,prepare};
}

test('C: real managed call reserves atomically and completes an immutable attempt from the original call revision',async t=>{
  const f=await setup(t), m=f.prepare(), beforeQuestion=f.store.get(f.v.plan.id), beforeDraft=f.store.get(f.v.draft.id);
  const write=f.store.writeMany.bind(f.store);let batch:string[]=[];
  f.store.writeMany=((writes,guards=[])=>{
    if(writes.some(w=>w.kind==='model-call'&&w.expected===0&&(w.value as any).status==='running')) batch=writes.map(w=>w.kind);
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  const response=await m.invoke();f.store.writeMany=write;
  for(const kind of ['research-budget','research-budget-ledger','model-call','research-consumer-intent','request-manifest'])
    assert.ok(batch.includes(kind),`${kind} in atomic first dispatch: ${batch}`);
  const execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));assert.equal(execution.kind,'response');
  const running=f.store.get<ResearchConsumerIntent>(m.intent.id)!;
  assert.equal(running.value.call!.revision,1);assert.ok(execution.call.revision>running.value.call!.revision);
  assert.equal(execution.call.value.status,'succeeded');
  const wire=f.wires().at(-1);assert.equal(wire.subject.question.id,'q-industry');
  assert.equal(wire.subject.question.text,f.questions[0]!.text);assert.equal(wire.subject.question.field,undefined);
  assert.equal(wire.subject.question.schema.oneOf.length,4);assert.deepEqual(wire.subject.subject,m.selected);
  const archive=f.store.get<any>(wire.subject.working.archive.id)!;
  assert.deepEqual(archive.value.question,reference(m.question));assert.deepEqual(archive.value.subject,m.selected);
  assert.deepEqual(execution.call.value.planAnswer,m.selected.planAnswer);assert.equal(execution.call.value.questionId,'q-industry');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:1,context:m.context,subject:m.selected});
  const turnId=managedTurnId(m.run.id,1);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id:turnId,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id:turnId,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const originalCall=f.store.get<ResearchConsumerIntent>(m.intent.id)!.value.call!;
  const recorded=recordV7Attempt(f.store,{project:'p',planAnswer:m.selected.planAnswer,planQuestionId:'q-industry',
    call:originalCall,end:attemptEndOfAction(response,m.selected)});
  const done=completeResearchAttemptTurn(f.store,'p',reference(f.store.get(turnId)!),reference(recorded.attempt));
  assert.equal(done.turn.value.status,'completed');assert.deepEqual(recorded.attempt.value.call,originalCall);
  assert.deepEqual(f.store.get(f.v.plan.id),beforeQuestion);assert.deepEqual(f.store.get(f.v.draft.id),beforeDraft);
});

test('C: two questions and two plan editions isolate continuation, progress, dispatch and exact cold replay',async t=>{
  const f=await setup(t), a=f.prepare();const paid=await a.invoke();const firstWire=f.wires().at(-1);
  const b=f.prepare(f.subject('q-market'));await b.invoke();
  assert.equal(f.wires().at(-1).subject.continuation.kind,'initial');
  const next=f.prepare();await next.invoke();assert.equal(f.wires().at(-1).subject.continuation.kind,'continuation');
  assert.equal(f.wires().at(-1).prompt.includes('compact checkpoint'),false);
  const edition=acceptNextPlanEdition(f,'p',f.v.draft,f.v.frameRef,f.v.planAnswer,f.questions);
  const c=f.prepare(f.subject('q-industry',edition.planAnswer));await c.invoke();
  assert.equal(f.wires().at(-1).subject.continuation.kind,'initial');
  const calls=f.store.list<ModelCall>('model-call').filter(x=>x.value.planAnswer);
  assert.equal(new Set(calls.map(x=>x.value.progressKey)).size,3);
  assert.equal(f.store.list<any>('continuation-state').filter(x=>x.value.subject).length,3);
  assert.equal(f.store.list<any>('question-dispatch').filter(x=>x.value.subject).length,3);
  const ledger=f.store.list('research-budget-ledger'), count=f.wires().length, snapshot=f.store.list().flatMap(r=>f.store.history(r.id));
  let replayContext:any;const fresh=f.open();
  assert.deepEqual(await a.invoke(fresh,c=>{replayContext=c;}),paid);
  assert.deepEqual(replayContext,firstWire.subject);assert.equal(f.wires().length,count);
  assert.deepEqual(fresh.list('research-budget-ledger'),ledger);assert.deepEqual(fresh.list().flatMap(r=>fresh.history(r.id)),snapshot);
  const oldCall=calls.find(x=>x.value.consumerIntent?.id===a.intent.id)!;
  assert.equal(readRequestWire(fresh,oldCall.value.request.record!).text,JSON.stringify(firstWire));
});

test('C: malformed subjects, cross-question packets and unbound v7 calls refuse before payment',async t=>{
  const f=await setup(t), m=f.prepare(), sends=f.wires().length, calls=f.store.list('model-call').length;
  for(const subject of [null,{}, {...m.selected,contract:'unknown'}, {...m.selected,planQuestionId:'missing'}]) {
    assert.throws(()=>workingContext(f.store,'p',f.v.draft.id,f.v.plan.id,{},60000,{subject:subject as any}),
      {code:'research_plan_subject_invalid'});
  }
  assert.throws(()=>workingContext(f.store,'p',f.v.draft.id,f.v.plan.id,{question:{id:'q-market'}},60000,{subject:m.selected}),
    {code:'research_plan_subject_invalid'});
  await assert.rejects(researchCall(f.environment.value.implementer,f.environment.value,f.prompt,{subject:m.selected},undefined,
    {store:f.store,draftId:f.v.draft.id,questionId:f.v.plan.id,purpose:'analyst'}),{code:'research_plan_subject_invalid'});
  await assert.rejects(researchCall(f.environment.value.implementer,f.environment.value,f.prompt,{},undefined,
    {store:f.store,draftId:f.v.draft.id,questionId:'q-industry',purpose:'analyst',consumerIntent:reference(m.intent)}),
    {code:'research_consumer_intent_invalid'});
  assert.throws(()=>workingContext(f.store,'p',f.v.draft.id,f.v.plan.id,{questions:{}},60000,{subject:m.selected}),
    {code:'research_plan_subject_invalid'});
  assert.equal(f.wires().length,sends);assert.equal(f.store.list('model-call').length,calls);
});

test('C: v7 planner and synthesis refuse before a send; exact subject cannot bypass common packing',async t=>{
  const f=await setup(t), m=f.prepare(), sends=f.wires().length;
  for(const purpose of ['reading-planner','synthesis','consolidation'])
    await assert.rejects(researchCall(f.environment.value.implementer,f.environment.value,f.prompt,{},undefined,
      {store:f.store,draftId:f.v.draft.id,questionId:f.v.plan.id,purpose}),{code:'research_v7_mode_unavailable'});
  assert.throws(()=>prepareResearchEnvelope(f.environment.value.implementer,f.environment.value,f.prompt,{},
    {store:f.store,draftId:f.v.draft.id,purpose:'analyst'},m.intent.value.cursor.resultCapacity),
    {code:'research_plan_subject_invalid'});
  assert.equal(f.wires().length,sends);
});

test('C: overrun reply and incident stay atomic, cold paid replay is free and another send is refused',async t=>{
  const f=await setup(t), m=f.prepare();writeFileSync(f.settings,JSON.stringify({tokens:V7_STAGE_TOKEN_CEILING+1}));
  const original=f.store.writeMany.bind(f.store);let atomic=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(writes.some(w=>w.kind==='budget-incident')) {
      assert.ok(writes.some(w=>w.kind==='model-response'));
      assert.ok(writes.some(w=>w.kind==='model-call'&&(w.value as any).status==='succeeded'));atomic=true;
    }
    return original(writes,guards);
  }) as typeof f.store.writeMany;
  const paid=await m.invoke();f.store.writeMany=original;assert.equal(atomic,true);
  const segment=f.store.get<BudgetSegment>(stageBudgetSegmentId('p'))!;
  assert.equal(budgetUsage(f.store,segment).measured,V7_STAGE_TOKEN_CEILING+2);
  const count=f.wires().length,ledger=f.store.list('research-budget-ledger');
  assert.deepEqual(await m.invoke(f.open()),paid);assert.equal(f.wires().length,count);
  assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  await assert.rejects(f.prepare(f.subject('q-market')).invoke(),{code:'discovery_budget_overrun'});
  assert.equal(f.wires().length,count);
});


test('C: a concurrent reservation guard rolls back segment, ledger, call, manifest and running intent before payment',async t=>{
  const f=await setup(t), m=f.prepare(), sends=f.wires().length, original=f.store.writeMany.bind(f.store);
  const rival=f.open(); let raced=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!raced && writes.some(w=>w.kind==='model-call'&&w.expected===0)) {
      raced=true; rival.write({id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:m.run.value});
    }
    return original(writes,guards);
  }) as typeof f.store.writeMany;
  await assert.rejects(m.invoke(),{code:'input_stale'}); f.store.writeMany=original;
  assert.equal(raced,true); assert.equal(f.wires().length,sends);
  for(const kind of ['research-budget','research-budget-ledger','request-manifest']) assert.equal(f.store.list(kind).length,0);
  assert.equal(f.store.list<ModelCall>('model-call').filter(c=>c.value.planAnswer).length,0);
  assert.deepEqual(f.store.get(m.intent.id),m.intent);
});


test('C: common reader transport remains available on the answered plan Question without an attempt subject',async t=>{
  const f=await setup(t);
  const old=f.discovery.create('p','discovery','R0','concept',[
    {field:'readerCalibration',kind:'fact',prompt:'Calibrate reader',risk:'unknown',schema:{type:'object'}}],[],6);
  const q=f.store.get<Question>(old.value.questions[0]!)!;
  await researchCall(f.environment.value.implementer,f.environment.value,'Read exact coordinates',
    {role:'reader',sources:[]},undefined,{store:f.store,draftId:old.id,questionId:q.id,purpose:'reader'});
  const sends=f.wires().length, basis=f.store.get(f.v.plan.id);
  await researchCall(f.environment.value.implementer,f.environment.value,'Read exact coordinates',
    {role:'reader',sources:[]},undefined,{store:f.store,draftId:f.v.draft.id,questionId:f.v.plan.id,purpose:'reader'});
  assert.equal(f.wires().length,sends+1);
  const call=f.store.list<ModelCall>('model-call').find(c=>c.value.draftId===f.v.draft.id&&c.value.purpose==='reader')!;
  assert.equal(call.value.questionId,f.v.plan.id);assert.equal(call.value.planAnswer,undefined);
  assert.equal(f.wires().at(-1).subject.question,undefined,'reader receives its sources protocol, never the plan FieldSpec');
  assert.deepEqual(f.store.get(f.v.plan.id),basis);
});


test('C: progress ignores foreign project, actor and purpose even when a call copies the exact progress key',async t=>{
  const f=await setup(t), m=f.prepare();await m.invoke();
  const call=f.store.list<ModelCall>('model-call').find(c=>c.value.consumerIntent?.id===m.intent.id)!;
  const progress=()=>invocationProgress(f.store,f.v.plan.id,'analyst',{},m.selected,'author');
  assert.equal(progress().key,call.value.progressKey);
  assert.deepEqual(progress().guards,[reference(call)]);
  for(const [name,patch] of [
    ['project',{projectId:'foreign-project'}],
    ['actor',{requested:{...call.value.requested,actor:'foreign-actor'}}],
    ['purpose',{purpose:'reader'}],
  ] as const) f.store.write({id:`model-call:foreign-${name}`,kind:'model-call',expected:0,value:{...call.value,...patch}});
  assert.deepEqual(progress().guards,[reference(call)]);
});
