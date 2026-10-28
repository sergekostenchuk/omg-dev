import {configureReaderPilot} from '../src/discovery/reader-pilot.js';
import test from 'node:test';
import {Ajv} from 'ajv';
import {hashJson} from '../src/canonical.js';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {discoveryFixture, planQuestion, validFrame, validPlan, questionOf} from './discovery-v7-fixture.js';
import {answerDiscoveryFixture} from './product-fixture.js';
import {checkV7Claims, V7_CLAIMS_SCHEMA, V7_AXES, V7_ATTEMPT_KIND, createPartialV7Draft} from '../src/discovery/v7-contracts.js';
import {type DiscoveryDraft, type Question} from '../src/discovery/discovery.js';
import {ProductEngine} from '../src/product/engine.js';
import {parseCommand} from '../src/product/commands.js';
import {ProducerPolicySessions, issueProducerPolicyInvitation, setProjectProducerPolicy} from '../src/product/producer-policy-authority.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {reference, type Ref} from '../src/pipeline/contracts.js';
import {readResearchConsumerIntent, readResearchConsumerTurn, type ResearchConsumerIntent} from '../src/discovery/response-recovery.js';
import {RESEARCH_READ_INSTRUCTION, RESEARCH_READ_SCHEMAS} from '../src/discovery/research-read-contract.js';
import {continuationPrompt, planClaimsContract} from '../src/discovery/continuation-packet.js';
import {researchAction} from '../src/discovery/research-consumer-transition.js';
import {stopRun} from '../src/om/run-control.js';
import type {Store} from '../src/storage/store.js';

function policy(store:Store, discovery:6|7, previous:Ref|null=null) {
  const scope={project:'p',discovery,previous}, sessions=new ProducerPolicySessions(store);
  const session=sessions.exchange(issueProducerPolicyInvitation(store,scope));
  try {return setProjectProducerPolicy(store,scope,session.authority).record;}
  finally {sessions.revoke(session.bearer);}
}
async function world(t:test.TestContext, tokens=10, planning=false, readFirst=false) {
  const f=discoveryFixture(t,'omg-live-forms-',true);
  f.engine.execute({type:'create-project',project:'p',title:'Forms'});
  const wire=join(f.root,'wire'),settings=join(f.root,'reply.json'),adapter=join(f.root,'adapter.mjs');
  writeFileSync(wire,'');
  const reply=(action:unknown,usage=10)=>writeFileSync(settings,JSON.stringify({action,usage}));
  reply({action:'pause',reason:'Calibration'});
  writeFileSync(adapter,`import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8')),s=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
appendFileSync(${JSON.stringify(wire)},JSON.stringify(r)+'\\n');
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:s.action,
usage:{inputTokens:s.usage,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const command={executable:process.execPath,args:[adapter]};
  const environment=f.engine.environments.configure('p',{workspace:f.root,
    implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},
    fullCheck:command,timeoutMs:15000},0);
  const probe=f.discovery.create('p','discovery','R0','concept',[{field:'probe',kind:'fact',prompt:'Calibrate',risk:'unknown',schema:{type:'string'}}],[],6);
  await researchCall(environment.value.implementer,environment.value,'Calibrate',{},undefined,
    {store:f.store,draftId:probe.id,questionId:probe.value.questions[0]!,purpose:'analyst'});
  if(planning) {
    await researchCall(environment.value.implementer,environment.value,'Calibrate planner',{dispatchMode:'planning'},undefined,
      {store:f.store,draftId:probe.id,questionId:probe.value.questions[0]!,purpose:'reading-planner'});
    configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
      reader:{actor:'reader',model:'fixture-reader',effort:'high',speed:'fast',command},agentCommand:command,
      maxRequestChars:100000,maxReadChars:20000,maxReplyChars:10000,maxCalls:20,maxReportedTokens:100000,
      v7Planning:{contract:'v7-plan-planning/v1',maxRequestChars:100000,maxRounds:4}},0);
  }
  writeFileSync(wire,'');
  const permitted=policy(f.store,7),base=createPartialV7Draft(f.discovery,'p','concept');
  const source=f.discovery.evidence.document('p','mandate','Construction materials. 😀 Owner mandate.','text/plain',0);
  const questions=[planQuestion('industry','industry','blocking')],frame=questionOf(f.store,base,'frame');
  answerDiscoveryFixture(f.engine,'p',base,frame,validFrame(questions),source);
  const frameRef=f.store.get<Question>(frame.id)!.value.answer!,plan=questionOf(f.store,base,'plan');
  answerDiscoveryFixture(f.engine,'p',base,plan,validPlan(frameRef,questions),source);
  const draft=f.store.get<DiscoveryDraft>(base.id)!;
  if(readFirst) {
    reply({action:'read_source',source:reference(source),start:0,end:source.value.content.length});
    await f.engine.execute({type:'research-draft',project:'p',draftId:draft.id,maxTurns:1});
    reply({necessary:true,reason:'An explicit jurisdiction choice is unavailable from the consulted source'});
    await researchCall(environment.value.reviewer,environment.value,'Calibrate escalation',{},undefined,
      {store:f.store,draftId:probe.id,questionId:probe.value.questions[0]!,purpose:'escalation-assessor'});
    writeFileSync(wire,'');
  }
  const malformed={action:'read_source',source:reference(source),purpose:'Determine the industry from the saved owner mandate'};
  reply(malformed,tokens);
  const wires=()=>readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const result=await f.engine.execute({type:'research-draft',project:'p',draftId:draft.id,maxTurns:1}) as any;
  assert.equal(result.value.pauseCode,'research_response_invalid',JSON.stringify(result.value));
  assert.equal(wires().length,1);
  const refused=f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(r=>r.value.state==='refused')!;
  assert.ok(refused);
  const commandRetry={type:'retry-plan-response' as const,project:'p',intent:reference(refused),limit:1 as const};
  const correct={action:'read_source',source:reference(source),start:0,end:source.value.content.length};
  reply(correct);
  return {...f,draft,source,refused,wires,reply,correct,permitted,commandRetry,result};
}

test('forms: the unchanged parser and every plan continuation share complete read schemas',()=>{
  const schemas=RESEARCH_READ_SCHEMAS as any[];
  const source=schemas.find(x=>x.properties.action.const==='read_source');
  assert.deepEqual(source.required,['action','source','start','end']);
  assert.equal(source.additionalProperties,false);assert.equal(source.properties.purpose,undefined);
  assert.ok(RESEARCH_READ_INSTRUCTION.includes('UTF-16'));
  for(const role of ['analyst','reading-planner']) assert.ok(continuationPrompt(role).includes(RESEARCH_READ_INSTRUCTION));
  assert.throws(()=>researchAction({action:'read_source',source:{id:'s',revision:1,hash:'a'.repeat(64)},purpose:'industry'}),{code:'research_response_invalid'});
  assert.throws(()=>parseCommand({type:'retry-plan-response',project:'p',intent:{id:'i',revision:1,hash:'a'.repeat(64)},limit:2}));
});

test('forms: paid syntax refusal requires its addressed correction; one new generation reads the source and cold replay is free',async t=>{
  const f=await world(t), old=f.store.history(f.refused.id),oldCall=f.store.get(f.refused.value.refusal!.call.id);
  const ordinary=await f.engine.execute({type:'research-draft',project:'p',draftId:f.draft.id,maxTurns:1}) as any;
  assert.equal(ordinary.value.pauseCode,'research_response_invalid');assert.equal(f.wires().length,1);
  const corrected=await f.engine.execute(parseCommand(f.commandRetry)) as any;
  assert.equal(corrected.value.pauseCode,'research_plan_response_corrected',JSON.stringify(corrected.value));
  assert.equal(f.wires().length,2);assert.deepEqual(f.store.history(f.refused.id),old);
  assert.deepEqual(f.store.get(oldCall!.id),oldCall);
  const successor=f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(r=>r.value.previous?.id===f.refused.id)!;
  assert.equal(successor.value.generation,1);assert.equal(successor.value.state,'applied');
  await assert.rejects(Promise.resolve().then(()=>f.engine.execute({...f.commandRetry,intent:reference(successor)})),{code:'research_plan_retry_invalid'});
  assert.deepEqual(successor.value.previous,reference(f.refused));
  const turns=f.store.list('research-turn');assert.equal(turns.length,1);
  const turn=readResearchConsumerTurn(f.store,reference(turns[0]!));
  assert.equal(turn.value.status,'completed');assert.deepEqual(turn.value.action,f.correct);
  assert.ok(JSON.stringify(turn.value.observation).includes('Construction materials'));
  const request=JSON.stringify(f.wires()[1]);assert.ok(request.includes('UTF-16'));
  assert.ok(request.includes('plan-response-correction/v1'));assert.ok(request.includes(f.refused.id));
  assert.ok(request.includes('required'));assert.ok(request.includes('additionalProperties'));
  const rows=f.store.list();const cold=new ProductEngine(f.open());
  await cold.execute({...f.commandRetry,restoreOnly:true});await cold.execute(f.commandRetry);
  assert.equal(f.wires().length,2);assert.deepEqual(f.store.list(),rows);
  f.reply({action:'pause',reason:'Next ordinary step'});
  const write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut&&writes.some(w=>w.kind==='model-call'&&w.expected===0)){cut=true;throw new Error('cut before later ordinary send');}
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  await f.engine.execute({type:'research-draft',project:'p',draftId:f.draft.id,maxTurns:1});f.store.writeMany=write;
  assert.equal(cut,true);const later=f.store.list();
  await cold.execute(f.commandRetry);assert.equal(f.wires().length,2);assert.deepEqual(f.store.list(),later);
  await cold.execute({type:'research-draft',project:'p',draftId:f.draft.id,maxTurns:1});
  assert.equal(f.wires().length,3);assert.equal(f.store.list('research-attempt').length,0);
});

for(const protection of ['restore','stop','policy','budget'] as const)
test(`forms: ${protection} prevents a new correcting send`,async t=>{
  const f=await world(t,protection==='budget'?20_000_000:10);
  if(protection==='stop') stopRun(f.store,{project:'p'});
  if(protection==='policy') policy(f.store,6,reference(f.permitted));
  const outcome=await f.engine.execute({...f.commandRetry,...(protection==='restore'?{restoreOnly:true}:{})}) as any;
  assert.equal(outcome.value.status,'paused');assert.equal(f.wires().length,1);
  assert.equal(outcome.value.pauseCode, {restore:'research_response_invalid',stop:'run_stopped',policy:'research_contract_upgrade_required',budget:'research_budget_exhausted'}[protection], JSON.stringify(outcome.value));
  if(protection==='restore') assert.equal(f.store.list('research-consumer-intent').length,1);
});

test('forms: an invalid correction stops, concurrent and repeated entries cannot buy another generation',async t=>{
  const f=await world(t);f.reply({action:'read_source',source:reference(f.source),purpose:'Still malformed'});
  const results=await Promise.allSettled([f.engine.execute(f.commandRetry),new ProductEngine(f.open()).execute(f.commandRetry)]);
  assert.ok(results.some(r=>r.status==='fulfilled'));
  assert.equal(f.wires().length,2);
  const next=f.store.list<ResearchConsumerIntent>('research-consumer-intent').find(r=>r.value.previous?.id===f.refused.id)!;
  assert.equal(next.value.state,'refused');
  await f.engine.execute(f.commandRetry);assert.equal(f.wires().length,2);
  assert.equal(f.store.list('research-consumer-intent').length,2);
  await assert.rejects(Promise.resolve().then(()=>f.engine.execute({...f.commandRetry,intent:{...f.commandRetry.intent,hash:'a'.repeat(64)}})));
  f.engine.execute({type:'create-project',project:'other',title:'Other'});
  await assert.rejects(Promise.resolve().then(()=>f.engine.execute({...f.commandRetry,project:'other'})),{code:'research_plan_retry_invalid'});
  assert.equal(f.wires().length,2);
  readResearchConsumerIntent(f.open(),reference(next));
});


test('forms: a paid correction cut is recovered under stop without another dispatch',async t=>{
  const f=await world(t),write=f.store.writeMany.bind(f.store);let cut=false;
  f.store.writeMany=((writes,guards=[])=>{
    if(!cut&&writes.some(w=>w.kind==='research-turn'&&w.expected===0)){cut=true;throw new Error('cut after correcting paid response');}
    return write(writes,guards);
  }) as typeof f.store.writeMany;
  await f.engine.execute(f.commandRetry);f.store.writeMany=write;
  assert.equal(cut,true);assert.equal(f.wires().length,2);
  stopRun(f.store,{project:'p'});
  const result=await new ProductEngine(f.open()).execute({...f.commandRetry,restoreOnly:true}) as any;
  assert.equal(result.value.pauseCode,'research_plan_response_corrected',JSON.stringify(result.value));
  assert.equal(f.wires().length,2);assert.equal(f.store.list('research-turn').length,1);
});


test('forms: the actual v7 planning request delivers full read contracts without opening analyst correction for a planner',async t=>{
  const f=await world(t,10,true),request=JSON.stringify(f.wires()[0]);
  assert.equal(f.refused.value.kind,'reading-planner');
  for(const token of ['UTF-16','read_source','additionalProperties','required','read_bundle','read_context']) assert.ok(request.includes(token),token);
  assert.ok(request.includes('Choose what to read'));
  assert.deepEqual(f.wires()[0].subject.discoveryClaims.schema,V7_CLAIMS_SCHEMA);
  await assert.rejects(Promise.resolve().then(()=>f.engine.execute(f.commandRetry)),{code:'research_plan_retry_invalid'});
  assert.equal(f.wires().length,1);
});


test('forms: a syntactically plausible refusal with a substituted response address cannot grant correction',async t=>{
  const f=await world(t);
  const fake=f.store.write<ResearchConsumerIntent>({id:f.refused.id,kind:f.refused.kind,expected:f.refused.revision,
    value:{...f.refused.value,refusal:{...f.refused.value.refusal!,response:reference(f.source)}}});
  await assert.rejects(Promise.resolve().then(()=>f.engine.execute({...f.commandRetry,intent:reference(fake)})),
    {code:'research_plan_retry_invalid'});
  assert.equal(f.wires().length,1);assert.equal(f.store.list('research-consumer-intent').length,1);
});


test('LIVE-FORMS-01: need_owner correction keeps its pending turn without purchasing escalation on cold/repeat/restoreOnly',async t=>{
  const f=await world(t,10,false,true);
  const before=f.store.list('model-call').length;
  f.reply({action:'need_owner',question:'industry',reason:'Choose the required jurisdiction',searched:[reference(f.source)]});
  const corrected=await f.engine.execute(f.commandRetry) as any;
  assert.equal(corrected.value.pauseCode,'research_plan_response_pending',JSON.stringify(corrected.value));
  assert.equal(f.store.list('model-call').length,before+1);assert.equal(f.wires().length,2);
  const turn=f.store.list<any>('research-turn').find(r=>r.value.number===2)!;
  assert.equal(turn.value.status,'pending');assert.equal(turn.value.action.action,'need_owner');
  assert.equal(f.store.list<ResearchConsumerIntent>('research-consumer-intent').filter(r=>r.value.kind==='escalation-assessor').length,0);
  const saved=f.store.list(),cold=new ProductEngine(f.open());
  for(const restoreOnly of [false,true,false]) await cold.execute({...f.commandRetry,restoreOnly});
  assert.equal(f.wires().length,2);assert.deepEqual(f.store.list(),saved);
  f.reply({necessary:true,reason:'An explicit jurisdiction choice is unavailable from the consulted source'});
  const ordinary=await cold.execute({type:'research-draft',project:'p',draftId:f.draft.id,maxTurns:1}) as any;
  assert.equal(ordinary.value.status,'needs_owner',JSON.stringify(ordinary.value));
  assert.equal(f.wires().length,3);assert.equal(f.store.list('model-call').length,before+2);
  await cold.execute(f.commandRetry);assert.equal(f.wires().length,3);
});


test('claims delivery: all five closed basis forms match the existing structural validator',()=>{
  const ref={id:'saved',revision:1,hash:'a'.repeat(64)};
  const link={project:'p',container:ref,containerKind:V7_ATTEMPT_KIND,pointer:'/claims/0',claimId:'prior'};
  const bases={fact:{source:{ref,range:{start:0,end:4},valueHash:hashJson('text')},limit:'Only the read fragment',asOf:'2026-10-29'},
    inference:{from:[link],reasoning:'Follows from the saved premise'},hypothesis:{howToVerify:'Measure actual usage'},
    unknown:{origin:'Plan research',unknownId:'u-1',question:'Which jurisdiction?',affects:['rules'],consumer:'concept',
      blocksCurrentStage:true,moment:'feasibility',closeCriterion:'Owner names the actual operating jurisdiction'},
    'owner-decision':{authority:ref}};
  const validate=new Ajv({strict:true}).compile(V7_CLAIMS_SCHEMA as object);
  const context={project:'p',planAnswer:ref,planQuestionId:'industry',projectRef:(r:Ref)=>r.id===ref.id&&r.hash===ref.hash&&r.revision===1};
  const branch=(V7_CLAIMS_SCHEMA as any).properties.claims.items.oneOf;
  assert.deepEqual(branch.map((b:any)=>b.properties.kind.const),Object.keys(bases));
  assert.deepEqual((V7_CLAIMS_SCHEMA as any).properties.claims.items.properties.axis.enum,[...V7_AXES]);
  for(const [kind,basis] of Object.entries(bases)) {
    const claim:any={id:kind,kind,text:'Research result',axis:'industry',planQuestions:[{planAnswer:ref,planQuestionId:'industry'}],
      scope:{variants:'common'},basis,contradicts:[],refutedBy:[],supersedes:null};
    assert.equal(validate({claims:[claim]}),true,JSON.stringify(validate.errors));checkV7Claims([claim],context);
    for(const field of Object.keys(basis)) {
      const absent=structuredClone(claim);delete absent.basis[field];
      assert.equal(validate({claims:[absent]}),false,kind+'.basis.'+field);
      assert.throws(()=>checkV7Claims([absent],context),{code:'attempt_invalid'});
    }
    for(const field of ['planQuestions','scope','basis']) {
      const absent=structuredClone(claim);delete absent[field];
      assert.equal(validate({claims:[absent]}),false,kind+'.'+field);
      assert.throws(()=>checkV7Claims([absent],context),{code:'attempt_invalid'});
    }
    const extra=structuredClone(claim);extra.basis.invented=true;
    assert.equal(validate({claims:[extra]}),false);assert.throws(()=>checkV7Claims([extra],context),{code:'attempt_invalid'});
  }
  assert.equal(validate({claims:[]}),false);assert.throws(()=>checkV7Claims([],context),{code:'attempt_claims_empty'});
});

test('claims delivery: the actual continuation carries full forms and real source pins; ordinary submitted records unknown and fact',async t=>{
  const f=await world(t);
  const oldRefusal=f.store.history(f.refused.id);
  assert.deepEqual(f.wires()[0].subject.discoveryClaims.schema,V7_CLAIMS_SCHEMA);
  assert.deepEqual(f.wires()[0].subject.discoveryClaims.sources,[]);
  await f.engine.execute(f.commandRetry);
  const subject=f.refused.value.cursor.subject!;
  const common={axis:'industry',planQuestions:[{planAnswer:subject.planAnswer,planQuestionId:'industry'}],scope:{variants:'common'}};
  const claims=[{...common,id:'jurisdiction',kind:'unknown',text:'Operating jurisdiction remains unknown',
    basis:{origin:'Owner mandate',unknownId:'jurisdiction',question:'Where will the product operate?',affects:['rules'],
      consumer:'concept',blocksCurrentStage:true,moment:'feasibility',closeCriterion:'Owner provides the operating jurisdiction'}},
    {...common,id:'industry-fact',kind:'fact',text:'The supplied mandate mentions construction materials',
      basis:{source:{ref:reference(f.source),range:{start:0,end:f.source.value.content.length},valueHash:hashJson(f.source.value.content)},
        limit:'Describes only the saved mandate, not independent market evidence',asOf:'2026-10-29'}}];
  f.reply({action:'answer',question:'industry',value:{type:'submitted',contract:'discovery-claims/v7',value:{claims}},citations:[]});
  await f.engine.execute({type:'research-draft',project:'p',draftId:f.draft.id,maxTurns:1});
  assert.equal(f.wires().length,3);
  const request=f.wires()[2],form=request.subject.discoveryClaims;
  assert.ok(form,JSON.stringify(request.subject).slice(0,700));
  assert.deepEqual(form.schema,V7_CLAIMS_SCHEMA);assert.deepEqual(form.subject,subject);
  assert.deepEqual(form.sources,[claims[1]!.basis.source]);
  for(const field of ['planQuestions','valueHash','closeCriterion','howToVerify','UTF-16'])
    assert.ok(JSON.stringify(request).includes(field),field);
  const attempts=f.store.list<any>(V7_ATTEMPT_KIND);assert.equal(attempts.length,1);
  assert.deepEqual(attempts[0]!.value.end,{type:'submitted',contract:'discovery-claims/v7',value:{claims}});
  assert.deepEqual(f.store.history(f.refused.id),oldRefusal);
  const read=f.store.list<any>('research-turn').find(row=>row.value.action.action==='read_source')!;
  const forged=structuredClone(read.value);forged.observation.value='Not the actual source';
  assert.throws(()=>planClaimsContract(f.store,'p',subject,[forged]),{code:'research_claim_source_invalid'});
});
