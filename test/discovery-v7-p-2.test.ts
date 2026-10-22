import { execFileSync } from 'node:child_process';
import { ResearchSources } from '../src/discovery/research-sources.js';
import { hashJson } from '../src/canonical.js';
import { DISCOVERY_CLAIMS_CONTRACT } from '../src/discovery/v7-contracts.js';
import { assessAttempts, assessAttemptsWithRequirements, readDiscoveryAssessment } from '../src/discovery/research-assessment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DiscoveryDraft, type Question } from '../src/discovery/discovery.js';
import { Store } from '../src/storage/store.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { researchSetup, rand, hypothesis, produce, type Entry } from './discovery-v7-fixture.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { prepareResearchConsumerIntent, prepareResearchConsumerApplication, readResearchConsumerExecution } from '../src/discovery/response-recovery.js';
import { projectPaidTurnAdmission, managedTurnId } from '../src/discovery/research-consumer-transition.js';
import { REQUEST_MANIFEST_CONTRACT } from '../src/discovery/request-parts.js';
import type { ResearchRun } from '../src/discovery/research-model.js';
import { processStart } from '../src/runtime/process-identity.js';
import { uniqueTransactionGuards } from '../src/runtime/environment.js';
import { projectAttemptPacket, v7ProgressStateId } from '../src/discovery/v7-attempt-assessment.js';
import { V7_PROGRESS_BASELINE_CONTRACT, type V7ProgressBaseline } from '../src/discovery/research-model.js';
import { type ClaimAddress } from '../src/discovery/claim-address.js';
import { checkV7AssessmentClosure } from '../src/discovery/v7-progress.js';
import { EngineError } from '../src/errors.js';

async function setup(t: test.TestContext) {
  const f = await researchSetup(t), { v, project, environment, subject, prompt } = f;
  let runId: string | undefined;
  const prepare=(selected=subject(), context:Record<string,any>={history:[],readings:[]})=>{
    const draft=f.store.get<DiscoveryDraft>(v.draft.id)!,question=f.store.get<Question>(v.plan.id)!;
    const run=runId ? f.store.get<ResearchRun>(runId)! : f.store.write<ResearchRun>({id:`research-run:${rand()}`,kind:'research-run',expected:0,
      value:{projectId:project,draftId:draft.id,environment:reference(environment),turns:0,limit:100,requestChars:0,
        owner:{pid:process.pid,started:processStart(process.pid)!},ownerQuestion:null,error:null,status:'running',inputs:draft.value.inputs}});
    runId=run.id; const number=run.value.turns+1;
    const input={projectId:project,kind:'analyst' as const,key:hashJson([run.id,number,'analyst']),owner:reference(run),draft:reference(draft),question:reference(question),
      role:environment.value.implementer,dispatch:environment.value,profile:null,
      cursor:{run:run.id,turn:number,instruction:prompt,context,subject:selected},basis:draft.value.inputs,
      guards:uniqueTransactionGuards([reference(run),reference(draft),reference(question),reference(environment)])};
    const intent=prepareResearchConsumerIntent(f.store,input);
    const invoke=(store=f.store,onContext?: (c:Record<string,any>)=>void)=>researchCall(environment.value.implementer,environment.value,prompt,context,undefined,
      {store,draftId:draft.id,questionId:question.id,purpose:'analyst',consumerIntent:reference(intent),requestContract:REQUEST_MANIFEST_CONTRACT,...(onContext?{onContext}:{})});
    return {run,number,intent,input,invoke,question,draft,selected,context};
  };
  return {...f,prepare};
}

type Setup = Awaited<ReturnType<typeof setup>>;
async function assess(f: Setup, entries:Entry[], options:{baseline?:V7ProgressBaseline;
  accept?:boolean; requirements?:boolean; question?:string; transition?:unknown; duplicates?:boolean; reverse?:boolean; methodology?:(claims:ClaimAddress[])=>unknown}={}) {
  const packet=projectAttemptPacket(f.store,{project:'p',planAnswer:f.v.planAnswer,
    planQuestionId:options.question??'q-industry',entries});
  const baseline=options.baseline??{contract:V7_PROGRESS_BASELINE_CONTRACT,state:{kind:'absent' as const,id:v7ProgressStateId(packet)},materials:[]};
  const claims:ClaimAddress[]=entries.flatMap(e=>{
    const row=f.store.get<any>(e.attempt.id,e.attempt.revision)!;
    return row.value.end.type==='submitted'?row.value.end.value.claims.map((claim:any,index:number)=>
      ({project:'p',container:e.attempt,containerKind:row.kind,pointer:`/claims/${index}`,claimId:claim.id})):[];
  });
  const accepted=options.accept?(options.reverse?[...claims].reverse():claims):[];
  const newClaims=options.duplicates?accepted.slice(0,1):accepted;
  const novelty={attempts:entries.map(e=>({attempt:e.attempt,reason:'Assessed exact result'})),
    accepted:accepted.map(claim=>({claim,reason:'Supported hypothesis'})),
    rejected:claims.filter(c=>!accepted.includes(c)).map(claim=>({claim,reason:'Unproved'})),
    newContent:newClaims.map(claim=>({claim,reason:'New basis'})),
    duplicates:options.duplicates?accepted.slice(1).map(claim=>({claim,of:accepted[0]!,reason:'Same content'})):[],
    noProgress:entries.filter(e=>!newClaims.some(c=>c.container.id===e.attempt.id)
      && !(options.transition as any)?.bases?.some((b:any)=>b.constraint?.id===e.attempt.id)).map(e=>({attempt:e.attempt,reason:'No new basis'})),
    transition:options.transition??null};
  const reply={verdict:'supported',reasons:['Assess exact packet'],return:null,novelty,
    methodology:options.methodology?.(claims)??{contract:'assessment-methodology/v1',policy:options.requirements?'assessment-methodology-policy/v2':'assessment-methodology-policy/v1',facts:[]}};
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply}));
  const paid=await (options.requirements?assessAttemptsWithRequirements:assessAttempts)(f.store,packet,baseline,f.environment,f.root);
  return {paid,packet,baseline,claims};
}
function factFixture(f:Setup, dated=false) {
  const source=f.discovery.evidence.document('p','measurement',JSON.stringify({fact:'A saved measurement is 42',...(dated?{published:'2026-10-21',event:'2026-10-20',version:'3.1'}:{})}),'application/json',0);
  const end={type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'h',kind:'fact',text:'A saved measurement is 42',
    axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
    basis:{source:{ref:reference(source),range:{start:0,end:source.value.content.length},valueHash:hashJson(source.value.content)},
      limit:'Single measurement',asOf:'Undated saved report'}}]}};
  const methodology=(claims:ClaimAddress[])=>{
    const evidence={source:reference(source),selector:{kind:'json-pointer',pointer:'/fact'}};
    return {contract:'assessment-methodology/v1',policy:'assessment-methodology-policy/v1',facts:[{
      claim:claims[0],significance:{kind:'blocking',reason:'Plan basis'},sources:[{source:reference(source),role:'primary',reason:'Original report',
        evidence:[evidence],original:reference(source),originalReason:'Original report',limitation:null,
        publicationDate:dated?{status:'known',value:'2026-10-21',evidence:[{...evidence,selector:{kind:'json-pointer',pointer:'/published'}}]}:{status:'unknown',reason:'Not published'},eventDate:{status:'unknown',reason:'Not dated'},
        version:dated?{status:'known',value:'3.1',evidence:[{...evidence,selector:{kind:'json-pointer',pointer:'/version'}}]}:{status:'unknown',reason:'No version'},retrievedAt:null}],
      temporalApplicability:{status:'established',scope:'Content of the saved report',reason:'This statement concerns the saved bytes',evidence:[evidence]},
      corroboration:{status:'single_confirmation',reason:'One report',limitation:'No independent confirmation'},
      refutation:{status:'not_performed',reason:'Not searched',traces:[],counterarguments:[],limitations:['Search remains']}}]};
  };
  return {end,methodology,source};
}
async function refutationSearch(f:Setup, question='q-industry') {
  execFileSync('git',['init','--quiet',f.root]);
  writeFileSync(join(f.root,'measurement.txt'),'Original measurement only.');
  execFileSync('git',['-C',f.root,'add','measurement.txt']);
  writeFileSync(f.settings,JSON.stringify({tokens:10,reply:{action:'search',query:'counterargument'}}));
  const m=f.prepare(f.subject(question)),response=await m.invoke(),execution=readResearchConsumerExecution(f.store,'p',reference(m.intent));
  assert.equal(execution.kind,'response');
  const projected=projectPaidTurnAdmission(m.run.value,{runId:m.run.id,intent:reference(m.intent),response,
    question:reference(m.question),owner:m.run.value.owner,limit:100,context:m.context,subject:m.selected});
  const id=managedTurnId(m.run.id,m.number);
  const application=prepareResearchConsumerApplication(f.store,reference(m.intent),reference(execution.call),[
    {id:m.run.id,kind:m.run.kind,expected:m.run.revision,value:projected.run},
    {id,kind:'research-turn',expected:0,value:projected.turn}],
    [reference(m.run),reference(f.environment),{id,absent:true}]);
  f.store.writeMany(application.writes,application.guards);
  const turn=f.store.get<any>(id)!;
  const result=new ResearchSources(f.store,'p',f.environment.value.workspace).searchCaptured('counterargument',turn);
  f.store.writeMany([result.capture,{id,kind:'research-turn',expected:turn.revision,value:result.turn}],result.guards);
  return {turn:reference(f.store.get(id)!),capture:result.captureRef};
}

type ClosureCase = 'none' | 'satisfied' | 'date' | 'version' | 'independence' | 'applicability'
  | 'not-searched' | 'unavailable' | 'counterargument' | 'search-limitation' | 'event-date' | 'secondary' | 'unknown-applicability';
async function closingAssessment(f: Setup, defect: ClosureCase) {
  const trace = await refutationSearch(f), fact = factFixture(f, defect === 'satisfied' || defect === 'event-date'), entry = await produce(f, fact.end);
  const claim: ClaimAddress = {project:'p',container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const transition = {outcome:'closed',bases:[{claim}],reason:'Criterion met',sufficiency:{criterion:f.questions[0]!.criterion,
    requiredDepth:f.questions[0]!.requiredDepth,reason:'The criterion concerns the saved measurement only',
    methodologyRequirements:[{claim,dated:defect==='date'||defect==='satisfied'||defect==='event-date',versioned:defect==='version'||defect==='satisfied',
      independentConfirmation:defect==='independence'||defect==='satisfied',reason:'Explicit criterion requirements for this saved original'}]}};
  const methodology = (claims: ClaimAddress[]) => {
    const value: any = fact.methodology(claims), row = value.facts[0];value.policy='assessment-methodology-policy/v2';
    row.sources[0].limitation='This original covers one deployment only';
    if(defect==='event-date') {
      row.sources[0].publicationDate={status:'unknown',reason:'Publication date unavailable'};
      row.sources[0].eventDate={status:'known',value:'2026-10-20',evidence:[{source:reference(fact.source),selector:{kind:'json-pointer',pointer:'/event'}}]};
    }
    if(defect==='secondary'){row.sources[0].role='secondary';row.sources[0].reason='Only the saved secondary report is accessible';}

    if(defect==='satisfied') {
      const other=f.discovery.evidence.document('p','independent-report',JSON.stringify({fact:'An independent report confirms 42',published:'2026-10-21',version:'3.1'}),'application/json',0);
      const second=structuredClone(row.sources[0]);second.source=reference(other);second.original=reference(other);
      for(const evidence of [...second.evidence,...second.publicationDate.evidence,...second.version.evidence])evidence.source=reference(other);
      row.sources.push(second);row.corroboration={status:'independent',sources:[reference(fact.source),reference(other)],reason:'Two independently authored original reports'};
    }
    row.refutation={status:'performed',reason:'Executed the named local search',traces:[trace],counterarguments:[],limitations:[]};
    if(defect==='applicability')row.temporalApplicability={status:'limited',scope:'Other deployment',reason:'Applicability remains unproven',evidence:[]};
    if(defect==='unknown-applicability')row.temporalApplicability={status:'unknown',scope:'Unestablished scope',reason:'No applicability evidence',evidence:[]};
    if(defect==='not-searched'||defect==='unavailable')row.refutation={status:defect==='not-searched'?'not_performed':'unavailable',reason:'Search omitted',traces:[],counterarguments:[],limitations:[]};
    if(defect==='counterargument'){row.refutation.counterarguments=[row.sources[0].evidence[0]];row.refutation.reason='Counterarguments resolved according to free text';}
    if(defect==='search-limitation')row.refutation.limitations=['Search did not cover a relevant second repository'];
    return value;
  };
  return {...await assess(f,[entry],{accept:true,requirements:true,transition,methodology}), fact, trace};
}

const snapshot = (store: Store) => store.list().flatMap(row => store.history(row.id));
for (const defect of ['none','satisfied','date','version','independence','applicability','not-searched','unavailable','counterargument','search-limitation','event-date','secondary','unknown-applicability'] as const) {
  test(`P.2: real paid closure enforces explicit methodology requirements: ${defect}`, async t => {
    const f = await setup(t), a = await closingAssessment(f, defect);
    const before = snapshot(f.store), sent = f.wires().length, ledger = f.store.list('research-budget-ledger');
    const check = (store = f.store) => checkV7AssessmentClosure(store, 'p', reference(a.paid),[]);
    if (defect === 'none' || defect === 'satisfied' || defect === 'event-date' || defect === 'secondary') {
      assert.deepEqual(check().transition, a.paid.value.novelty.transition);
      assert.deepEqual(check().methodologyOrigins, a.paid.value.methodology.facts.map(fact=>({claim:fact.claim,assessment:reference(a.paid)})));
      // Callers cannot mutate the saved assessment through the projection.
      const result = check().transition!; result.reason = 'Changed by caller';
      assert.deepEqual(check(f.open()).transition, a.paid.value.novelty.transition);
    } else for (const db of [f.store, f.open()]) assert.throws(() => check(db), (error: unknown) => {
      assert.ok(error instanceof EngineError);assert.equal(error.code, 'discovery_novelty_invalid');
      assert.equal((error.details as {field:string}).field, 'transition.sufficiency.methodologyRequirements.0');
      const gap = {date:'date_unproven',version:'version_unproven',independence:'single_confirmation',
        applicability:'applicability_unproven','unknown-applicability':'applicability_unproven','not-searched':'refutation_unperformed',unavailable:'refutation_unperformed',
        counterargument:'refutation_unresolved','search-limitation':'refutation_unresolved'}[defect];
      assert.ok(error.message.includes(gap));return true;
    });
    assert.deepEqual(snapshot(f.store), before); assert.equal(f.wires().length, sent);
    assert.deepEqual(f.store.list('research-budget-ledger'), ledger);
    assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)), a.paid);
    assert.equal(f.store.list('v7-progress-state').length, 0);
    assert.equal(f.store.list('v7-attempt-account').length, 0);
  });
}

test('P.2: paid classification of a limited fact does not close or require independent confirmation', async t => {
  const f = await setup(t), fact = factFixture(f), entry = await produce(f, fact.end);
  const a = await assess(f,[entry],{accept:true,requirements:true,methodology:claims => {
    const value:any=fact.methodology(claims);value.policy='assessment-methodology-policy/v2';return value;
  }});
  assert.equal(a.paid.value.novelty.accepted.length, 1);
  assert.equal(a.paid.value.methodology.facts[0]!.corroboration.status, 'single_confirmation');
  const before=snapshot(f.store);assert.equal(checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[]).transition,null);
  assert.deepEqual(snapshot(f.store),before);
});

test('P.2: historical v2 remains readable and cannot acquire missing fact-closing requirements', async t => {
  const f=await setup(t),fact=factFixture(f),entry=await produce(f,fact.end);
  const claim:ClaimAddress={project:'p',container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const a=await assess(f,[entry],{accept:true,methodology:fact.methodology,
    transition:{outcome:'closed',bases:[{claim}],reason:'Criterion met',sufficiency:{criterion:f.questions[0]!.criterion,
      requiredDepth:f.questions[0]!.requiredDepth,reason:'Sufficient'}}});
  assert.equal(a.paid.value.contract,'discovery-assessment/v2');
  const before=snapshot(f.store), sent=f.wires().length;
  assert.throws(()=>checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[]),{code:'discovery_novelty_invalid'});
  assert.deepEqual(readDiscoveryAssessment(f.open(),'p',reference(a.paid)),a.paid);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,sent);
  assert.ok(!Object.hasOwn(a.paid.value.novelty.transition!.sufficiency!,'methodologyRequirements'));
});

for (const requirements of [false,true]) test(`P.2: a known non-factual closure has explicit empty coverage in ${requirements?'v3':'v2'}`,async t=>{
  const f=await setup(t),entry=await produce(f,hypothesis(f,'A declared non-factual basis'));
  const claim:ClaimAddress={project:'p',container:entry.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const a=await assess(f,[entry],{accept:true,requirements,transition:{outcome:'closed',bases:[{claim}],reason:'Non-factual criterion met',
    sufficiency:{criterion:f.questions[0]!.criterion,requiredDepth:f.questions[0]!.requiredDepth,reason:'The question concerns the declared hypothesis',
      ...(requirements?{methodologyRequirements:[]}:{})}}});
  const before=snapshot(f.store);
  if(requirements) assert.equal(checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[]).transition!.outcome,'closed');
  else assert.throws(()=>checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[]),{code:'discovery_novelty_invalid'});
  assert.deepEqual(snapshot(f.store),before);
});

for(const limited of [true,false]) test(`P.2: shared transitive fact ${limited?'with unmet':'with met'} applicability is checked once`, async t => {
  const f=await setup(t),trace=await refutationSearch(f),fact=factFixture(f),one=await produce(f,fact.end);
  const address:ClaimAddress={project:'p',container:one.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const inference={type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{
    id:'derived',kind:'inference',text:'The saved measurement implies the criterion',axis:'industry',
    planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],scope:{variants:'common'},
    basis:{from:[address],reasoning:'Arithmetic applied to the measured quantity'}}]}};
  const two=await produce(f,inference),derived:ClaimAddress={...address,container:two.attempt,claimId:'derived'};
  const transition={outcome:'closed',bases:[{claim:derived},{claim:address}],reason:'The shared factual premise meets this criterion',
    sufficiency:{criterion:f.questions[0]!.criterion,requiredDepth:f.questions[0]!.requiredDepth,reason:'The exact saved criterion is satisfied',
      methodologyRequirements:[{claim:address,dated:false,versioned:false,independentConfirmation:false,reason:'Saved bytes suffice'}]}};
  const a=await assess(f,[one,two],{accept:true,requirements:true,transition,methodology:claims=>{
    const value:any=fact.methodology(claims);value.policy='assessment-methodology-policy/v2';
    value.facts[0].refutation={status:'performed',reason:'Executed search',traces:[trace],counterarguments:[],limitations:[]};
    if(limited)value.facts[0].temporalApplicability={status:'limited',scope:'Different scope',reason:'Not established',evidence:[]};
    return value;
  }}),before=snapshot(f.store);
  if(limited) assert.throws(()=>checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[]),{code:'discovery_novelty_invalid'});
  else {const checked=checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[]);assert.equal(checked.transition!.outcome,'closed');assert.equal(checked.methodologyOrigins.length,1);}
  assert.deepEqual(snapshot(f.store),before);
});

test('P.2: an unrelated limited fact does not add requirements to a non-factual closing basis',async t=>{
  const f=await setup(t),fact=factFixture(f),one=await produce(f,fact.end),two=await produce(f,hypothesis(f,'A separate non-factual criterion'));
  const claim:ClaimAddress={project:'p',container:two.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'h'};
  const a=await assess(f,[one,two],{accept:true,requirements:true,transition:{outcome:'closed',bases:[{claim}],reason:'Only the hypothesis grounds this criterion',
    sufficiency:{criterion:f.questions[0]!.criterion,requiredDepth:f.questions[0]!.requiredDepth,reason:'The stated criterion is non-factual',methodologyRequirements:[]}},
    methodology:claims=>{const value:any=fact.methodology(claims);value.policy='assessment-methodology-policy/v2';return value;}});
  const before=snapshot(f.store);assert.equal(checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[]).transition!.outcome,'closed');
  assert.deepEqual(snapshot(f.store),before);
});

test('P.2: a paid Ref is mandatory and a structural assessment cannot masquerade as its physical terminal',async t=>{
  const f=await setup(t),a=await closingAssessment(f,'none'),ref=reference(a.paid);
  for(const [project,request] of [['other',ref],['p',{...ref,hash:'0'.repeat(64)}],['p',{...ref,revision:2}],['p',a.paid.value],['p',null]] as const) {
    const before=snapshot(f.store);
    assert.throws(()=>checkV7AssessmentClosure(f.open(),project,request as Ref,[]),{code:'discovery_assessment_invalid'});
    assert.deepEqual(snapshot(f.store),before);
  }
  // Explicit negative corruption: a self-consistent record carrying genuine
  // session/application Refs, but with changed paid requirements or sufficiency.
  // It is never submitted as a positive paid/accepted fixture.
  for(const corrupt of [
    (value:any)=>{value.novelty.transition.sufficiency.methodologyRequirements[0].dated=true;},
    (value:any)=>{delete value.novelty.transition.sufficiency.methodologyRequirements;},
    (value:any)=>{value.novelty.transition.sufficiency.criterion='Another criterion';},
    (value:any)=>{value.novelty.transition.sufficiency.requiredDepth='shallow';},
    (value:any)=>{value.methodology.policy='assessment-methodology-policy/v1';},
  ]) {
    const value=structuredClone(a.paid.value);corrupt(value);
    const fake=f.store.write({id:`negative-only-assessment:${rand()}`,kind:'discovery-assessment',expected:0,value});
    const before=snapshot(f.store),sent=f.wires().length;
    assert.throws(()=>checkV7AssessmentClosure(f.open(),'p',reference(fake),[]),{code:'discovery_assessment_invalid'});
    assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,sent);
  }
  assert.equal(checkV7AssessmentClosure(f.open(),'p',ref,[]).transition!.outcome,'closed');
});

async function historicalMethodology(f:Setup, version:'v2'|'v3') {
  const trace=await refutationSearch(f,'q-market'),fact=factFixture(f),end=structuredClone(fact.end);
  end.value.claims[0]!.planQuestions=[{planAnswer:f.v.planAnswer,planQuestionId:'q-market'}];
  const entry=await produce(f,end,'q-market');
  const original=await assess(f,[entry],{accept:true,question:'q-market',requirements:version==='v3',methodology:claims=>{
    const value:any=fact.methodology(claims);value.policy=`assessment-methodology-policy/${version==='v3'?'v2':'v1'}`;
    value.facts[0].refutation={status:'performed',reason:'Executed original search',traces:[trace],counterarguments:[],limitations:[]};
    return value;
  }});
  // This is a genuine paid classification, deliberately not a fake progress
  // acceptance. P.3/P.4 must subsequently prove its accepted application.
  assert.equal(f.store.list('v7-progress-state').length,0);
  const premise=original.claims[0]!;
  const inferred={type:'submitted',contract:DISCOVERY_CLAIMS_CONTRACT,value:{claims:[{id:'deduced',kind:'inference',
    text:'The historical measurement answers this question',axis:'industry',planQuestions:[{planAnswer:f.v.planAnswer,planQuestionId:'q-industry'}],
    scope:{variants:'common'},basis:{from:[premise],reasoning:'Derive the criterion from the exact measured result'}}]}};
  const next=await produce(f,inferred),claim:ClaimAddress={project:'p',container:next.attempt,containerKind:'research-attempt',pointer:'/claims/0',claimId:'deduced'};
  const transition={outcome:'closed',bases:[{claim}],reason:'The saved measurement grounds the derivation',
    sufficiency:{criterion:f.questions[0]!.criterion,requiredDepth:f.questions[0]!.requiredDepth,reason:'Exact criterion and required depth',
      methodologyRequirements:[{claim:premise,dated:false,versioned:false,independentConfirmation:false,reason:'Saved original satisfies this criterion'}]}};
  const baseline:V7ProgressBaseline={contract:V7_PROGRESS_BASELINE_CONTRACT,
    state:{kind:'absent',id:v7ProgressStateId({project:'p',planAnswer:f.v.planAnswer,planQuestionId:'q-industry'})},materials:[premise]};
  const a=await assess(f,[next],{accept:true,requirements:true,baseline,transition});
  return {a,original,premise,claim,origin:{claim:premise,assessment:reference(original.paid)}};
}
for(const version of ['v2','v3'] as const) test(`P.2: exact historical ${version} methodology of another question grounds transitive closure without claiming acceptance`,async t=>{
  const f=await setup(t),h=await historicalMethodology(f,version),before=snapshot(f.store),sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  assert.equal(h.original.packet.planQuestionId,'q-market');assert.equal(h.a.packet.planQuestionId,'q-industry');
  assert.equal(h.a.paid.value.methodology.facts.length,0);
  const expected={assessment:reference(h.a.paid),transition:h.a.paid.value.novelty.transition,methodologyOrigins:[h.origin]};
  for(const db of [f.store,f.open()]) assert.deepEqual(checkV7AssessmentClosure(db,'p',reference(h.a.paid),[h.origin]),expected);
  const result=checkV7AssessmentClosure(f.open(),'p',reference(h.a.paid),[h.origin]);
  result.methodologyOrigins[0]!.claim.claimId='Changed';result.assessment.hash='0'.repeat(64);
  assert.deepEqual(checkV7AssessmentClosure(f.open(),'p',reference(h.a.paid),[h.origin]),expected);
  assert.equal(h.original.paid.value.methodology.policy,`assessment-methodology-policy/${version==='v3'?'v2':'v1'}`);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.equal(f.store.list('v7-attempt-account').length,0);assert.equal(f.store.list('research-progress-event').length,0);
});

test('P.2: historical methodology origins reject missing, foreign, duplicate, ambiguous, extra and wrong exact sources',async t=>{
  const f=await setup(t),h=await historicalMethodology(f,'v2');
  const cases:{origins:unknown;field:string}[]=[
    {origins:undefined,field:'methodologyOrigins'}, {origins:null,field:'methodologyOrigins'},
    {origins:[],field:'transition.sufficiency.methodologyRequirements.0.claim'},
    {origins:[{claim:h.premise}],field:'methodologyOrigins.0'},
    {origins:[{claim:h.premise,assessment:null}],field:'methodologyOrigins.0'},
    {origins:[{...h.origin,extra:true}],field:'methodologyOrigins.0'},
    {origins:[h.origin,h.origin],field:'methodologyOrigins.1.claim'},
    {origins:[h.origin,{...h.origin,assessment:reference(h.a.paid)}],field:'methodologyOrigins.1.claim'},
    {origins:[{...h.origin,claim:{...h.premise,project:'other'}}],field:'methodologyOrigins.0.claim'},
    {origins:[{...h.origin,claim:{...h.premise,containerKind:'research-answer'}}],field:'methodologyOrigins.0.claim'},
    {origins:[{...h.origin,claim:{...h.premise,pointer:'/claims/1'}}],field:'methodologyOrigins.0.claim'},
    {origins:[{...h.origin,claim:{...h.premise,claimId:'other'}}],field:'methodologyOrigins.0.claim'},
    {origins:[{...h.origin,claim:{...h.premise,extra:true}}],field:'methodologyOrigins.0.claim'},
    {origins:[{...h.origin,assessment:{...h.origin.assessment,hash:'0'.repeat(64)}}],field:'methodologyOrigins.0.assessment'},
    {origins:[{...h.origin,assessment:{...h.origin.assessment,revision:2}}],field:'methodologyOrigins.0.assessment'},
    {origins:[{...h.origin,assessment:reference(h.a.paid)}],field:'methodologyOrigins.0.claim'},
    {origins:[h.origin,{claim:h.claim,assessment:reference(h.a.paid)}],field:'methodologyOrigins.1.claim'},
  ];
  const before=snapshot(f.store),sent=f.wires().length,ledger=f.store.list('research-budget-ledger');
  for(const item of cases) assert.throws(()=>checkV7AssessmentClosure(f.open(),'p',reference(h.a.paid),item.origins as any),(error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal(error.code,'discovery_novelty_invalid');
    assert.equal((error.details as {field:string}).field,item.field);return true;
  });
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.wires().length,sent);assert.deepEqual(f.store.list('research-budget-ledger'),ledger);
  assert.deepEqual(checkV7AssessmentClosure(f.open(),'p',reference(h.a.paid),[h.origin]).methodologyOrigins,[h.origin]);
});

test('P.2: mappings for current or unused facts are refused instead of silently replacing paid methodology',async t=>{
  const f=await setup(t),a=await closingAssessment(f,'none'),origin={claim:a.claims[0]!,assessment:reference(a.paid)};
  const before=snapshot(f.store);
  assert.throws(()=>checkV7AssessmentClosure(f.open(),'p',reference(a.paid),[origin]),(error:unknown)=>{
    assert.ok(error instanceof EngineError);assert.equal((error.details as {field:string}).field,'methodologyOrigins.0.claim');return true;
  });
  assert.deepEqual(snapshot(f.store),before);
});
