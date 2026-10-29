import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { discoveryResponseContract } from '../src/discovery/discovery-response-contract.js';
import { decodeVariantGeneration, decodeVariantDecisionAnswer, VARIANT_CRITERIA } from '../src/discovery/discovery-variants.js';
import { decodeFrameInterpretations } from '../src/discovery/frame-interpretations.js';
import { requireEscalationReply } from '../src/discovery/early-research-outcome.js';
import { researchAction } from '../src/discovery/research-consumer-transition.js';
import { webAction } from '../src/discovery/web-research.js';
import { prepareResearchEnvelope } from '../src/discovery/research-protocol.js';
import { workingContext } from '../src/discovery/working-context.js';
import { createPartialV7Draft } from '../src/discovery/v7-contracts.js';
import { discoveryFixture } from './discovery-v7-fixture.js';
import { deliveredContract } from './discovery-response-contract-fixture.js';
const ref = { id:'source:p:original', revision:1, hash:'a'.repeat(64) };
const judgement = { conclusion:'Bounded', grounds:[ref], assumptions:[], unknowns:[], quantity:{unit:'days',minimum:1,maximum:3,limitations:'Estimate',grounds:[ref]} };
const variants = { action:'variants',variants:[{key:'one',title:'One',proposal:{scope:'Bounded'},criteria:Object.fromEntries(VARIANT_CRITERIA.map(k=>[k,judgement]))}],
  scale:Object.fromEntries(VARIANT_CRITERIA.map(k=>[k,'Evidence and declared uncertainty'])),comparison:'One option',recommendation:{key:'one',reason:'Fits'},searchLimits:['Original only'],unknowns:[] };

test('LIVE-FORMS-03: variant forms expose all nested fields and preserve decoder refusals',()=>{
  const proposal = discoveryResponseContract('variant-proposal',{})!;
  const validate = new Ajv({strict:true}).compile(proposal.schema);
  assert.ok(validate(variants),JSON.stringify(validate.errors));assert.deepEqual(decodeVariantGeneration(variants),variants);
  const none={action:'no_variants',reasons:[{code:'unsupported',message:'No supported option',grounds:[ref]}],searchLimits:['Source only'],unknowns:[]};
  assert.ok(validate(none));assert.deepEqual(decodeVariantGeneration(none),none);
  for(const change of [(x:any)=>delete x.variants[0].criteria.risk.quantity,(x:any)=>x.variants[0].criteria.extra=judgement,
    (x:any)=>delete x.searchLimits,(x:any)=>x.variants[0].paid=true]) {
    const invalid=structuredClone(variants);change(invalid);assert.equal(validate(invalid),false);assert.throws(()=>decodeVariantGeneration(invalid));
  }
  for(const answer of [{action:'choose',key:'one',reason:'Fits'},{action:'reject_all',reason:'No option fits'}]) {
    const check=new Ajv({strict:true}).compile(discoveryResponseContract('variant-decision',{})!.schema);
    assert.ok(check(answer));assert.deepEqual(decodeVariantDecisionAnswer(answer),answer);
  }
  assert.match(proposal.instruction,/minimum <= maximum/);assert.match(proposal.instruction,/unique local keys/);
});

test('LIVE-FORMS-03: interpretation support, closed continuations and web forms match their shared decoders',()=>{
  const interpretations={contract:'frame-interpretations/v1',projectId:'p',brief:{source:ref,selector:{kind:'text-range',start:0,end:10}},frame:ref,previousSet:null,
    outcome:'material',reason:'Distinct bounds',interpretations:['a','b'].map(id=>({id,meaning:id,consequences:[{affects:'boundaries',text:'Boundary '+id}],support:[{kind:'text-range',start:0,end:5}]}))};
  const schema=discoveryResponseContract('frame-interpretation-request',{})!.schema;
  const interpretationForm=new Ajv({strict:true}).compile(schema);
  assert.ok(interpretationForm(interpretations));assert.deepEqual(decodeFrameInterpretations(interpretations),interpretations);
  const noDivergence={...interpretations,outcome:'no_divergence',interpretations:[]};
  assert.ok(interpretationForm(noDivergence));assert.deepEqual(decodeFrameInterpretations(noDivergence),noDivergence);
  const missing:any=structuredClone(noDivergence);delete missing.interpretations;
  assert.equal(interpretationForm(missing),false);assert.throws(()=>decodeFrameInterpretations(missing));
  const escalation={necessary:false,reason:'A technical failure is not an owner question'};
  assert.ok(new Ajv({strict:true}).compile(discoveryResponseContract('escalation-assessor',{})!.schema)(escalation));requireEscalationReply(escalation);
  const analyst=discoveryResponseContract('analyst',{webResearch:{enabled:true}})!;
  const validate=new Ajv({strict:true}).compile(analyst.schema);
  for(const action of [{action:'web_search',query:'requirements',purpose:'Find primary source'},
    {action:'web_fetch',url:'https://example.test/doc',purpose:'Read primary source'}]) {assert.ok(validate(action));assert.deepEqual(webAction(action),action);}
  const read={action:'read_source',source:ref,start:0,end:10};assert.ok(validate(read));assert.deepEqual(researchAction(read),read);
  assert.equal(validate({...read,purpose:'Undeclared'}),false);assert.throws(()=>researchAction({...read,purpose:'Undeclared'}));
});

test('LIVE-FORMS-03: actual bounded packets preserve complete reply contracts, old questions and legacy absence',t=>{
  const f=discoveryFixture(t,'omg-all-forms-');const draft=createPartialV7Draft(f.discovery,'p','concept');
  const question=f.store.get<any>(draft.value.questions[0]!)!,before=structuredClone(question);
  const command={executable:process.execPath,args:['--version']};
  const environment=f.engine.environments.configure('p',{workspace:f.root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:1000},0);
  for(const purpose of ['analyst','reader','reading-planner','escalation-assessor','assessor']) {
    const body={};
    const packet=prepareResearchEnvelope(environment.value.implementer,environment.value,'Read the exact field',body,{store:f.store,draftId:draft.id,questionId:question.id,purpose});
    deliveredContract(f.store,packet,purpose);
  }
  const bounded=prepareResearchEnvelope(environment.value.implementer,environment.value,'Read the exact field',{},
    {store:f.store,draftId:draft.id,questionId:question.id,purpose:'analyst'},undefined,undefined,undefined,12000);
  assert.ok(bounded.input.length<=12000);
  const sent=JSON.parse(bounded.input);
  assert.ok(sent.subject.discoveryResponseContract || sent.subject.working.materialAddresses.some((a:any)=>a.field==='discoveryResponseContract'));
  deliveredContract(f.store,sent,'analyst');
  assert.deepEqual(f.store.get(question.id,question.revision),before);
  const legacy=f.discovery.create('p','discovery','R0','concept',[{field:'probe',kind:'fact',prompt:'Probe',risk:'unknown',schema:{type:'string'}}],[],6);
  const packet=workingContext(f.store,'p',legacy.id,legacy.value.questions[0]!,{},20000,{purpose:'analyst',common:true});
  assert.equal(packet.discoveryResponseContract,undefined);
});


test('LIVE-FORMS-03: cyclic deep declares executable actions; saved single-answer deep is not silently upgraded',()=>{
  const body={deepPreparation:ref,subject:{planQuestionId:'q'},question:{schema:{type:'object'}},webResearch:{enabled:true}};
  const legacy=discoveryResponseContract('analyst',body)!;
  const oldCheck=new Ajv({strict:true}).compile(legacy.schema);
  const read={action:'read_source',source:ref,start:0,end:10};
  const answer={action:'answer',question:'q',value:{},citations:[]};
  assert.equal(oldCheck(read),false);assert.ok(oldCheck(answer));
  const current=discoveryResponseContract('analyst',{...body,deepResearchContract:'deep-research-cycle/v1'})!;
  const check=new Ajv({strict:true}).compile(current.schema);
  for(const action of [read,answer,{action:'web_search',query:'source',purpose:'Find primary'},
    {action:'web_fetch',url:'https://example.test',purpose:'Read original'},
    {action:'need_owner',question:'q',reason:'Only owner knows',searched:[ref]}, {action:'pause',reason:'No remaining budget'}]) assert.ok(check(action),JSON.stringify(check.errors));
  assert.throws(()=>discoveryResponseContract('analyst',{...body,deepResearchContract:'unknown'}),{code:'research_deep_subject_invalid'});
});


test('LIVE-FORMS-03-01: synthesis selects the execution subset even with analyst purpose and web capability',()=>{
  for(const purpose of ['analyst','synthesis']) {
    const body={dispatchMode:'synthesis',webResearch:{enabled:true},subject:{planQuestionId:'q'},question:{schema:{type:'object'}}};
    const contract=discoveryResponseContract(purpose,body)!;
    const forms=(contract.schema.oneOf as any[]).map(form=>form.properties.action.const).sort();
    assert.deepEqual(forms,['answer','checkpoint','read_context','need_research','need_owner','pause'].sort());
    const validate=new Ajv({strict:true}).compile(contract.schema);
    for(const action of [{action:'search',query:'q'},{action:'read',path:'source',media:'text/plain'},
      {action:'read_source',source:ref,start:0,end:1},{action:'web_search',query:'q',purpose:'p'},
      {action:'web_fetch',url:'https://example.test',purpose:'p'}]) assert.equal(validate(action),false);
  }
});
