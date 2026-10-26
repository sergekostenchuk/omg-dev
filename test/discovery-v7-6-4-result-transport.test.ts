import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical, hashJson, type Json } from '../src/canonical.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { Store } from '../src/storage/store.js';
import type { DiscoveryDraft } from '../src/discovery/discovery.js';
import { prepareDossierResearchEnvelope, researchCall } from '../src/discovery/research-protocol.js';
import { projectResearchPhysicalReply } from '../src/discovery/research-consumer-transition.js';
import { applyDiscoveryAssessment } from '../src/discovery/v7-progress.js';
import type { ClaimAddress } from '../src/discovery/claim-address.js';
import { produceSelectedDossier } from '../src/discovery/selected-dossier.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import type { VariantNone } from '../src/discovery/discovery-variants.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { requireDossierTransportArchive } from '../src/discovery/continuation-packet.js';
import { archivedContext, contextPage, contextValue } from '../src/discovery/working-context.js';
import { requirePacketMaterialDelivery, measureResearchResult, type ResearchResultCapacity } from '../src/discovery/research-delivery.js';

import { completed, paid, money, modeOf, nextPlan, all, unchanged, untouched, fixedPoint, claim, deep, addresses, assess, revise, type Paid } from './discovery-v7-dossier-seed.js';

import { DOSSIER_RESULT_TRANSPORT, DOSSIER_REPLY_FORMS, dossierReplyContract } from '../src/discovery/continuation-packet.js';
import { checkDossierResearchReply } from '../src/discovery/early-research-outcome.js';
import { DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult } from '../src/discovery/research-model.js';
import { checkDossierAssessmentResult } from '../src/discovery/dossier-assessment.js';
import { configureReaderPilot, type ReaderPilot } from '../src/discovery/reader-pilot.js';
import type { Revision } from '../src/storage/store.js';
function replyFor(packet: DossierAssessmentPacket, verdict: 'supported' | 'return' = 'supported'): DossierAssessmentResult {
  const bases = [{ record: packet.manifest.ref }];
  return { contract: DOSSIER_ASSESSMENT_RESULT_CONTRACT, subject: structuredClone(packet.subject), verdict,
    reasons: ['The saved dossier is assessed at its own boundary'],
    quality: Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(dimension => [dimension,
      { judgement: 'adequate', reason: `Reviewed ${dimension} against the saved goal and scale`, bases }])) as DossierAssessmentResult['quality'],
    inventory: { materials: packet.materials.map(item => item.address), unknowns: packet.unknowns.map(item => item.unknown.claim),
      contradictions: packet.contradictions.map(item => ({ id: item.contradiction.id,
        sides: item.sides.map(side => side.address) as [ClaimAddress, ClaimAddress], grounds: item.grounds.map(record => record.ref) })) },
    return: verdict === 'return' ? { targets: [{ axis: 'market' }], reason: 'Collect an addressed market basis', bases } : null };
}

function onlyNewArchives(before:string,after:string) {
  const prior=JSON.parse(before),next=JSON.parse(after),known=new Set(prior.heads.map((row:any)=>row.entity_id));
  const added=new Set<string>(next.heads.filter((row:any)=>!known.has(row.entity_id)).map((row:any)=>row.entity_id));
  assert.ok(added.size>0);assert.ok([...added].every(id=>id.startsWith('research-context:')));
  for(const table of ['heads','revisions'])assert.deepEqual(next[table].filter((row:any)=>!added.has(row.entity_id)),prior[table]);
}
const instruction='Assess this exact saved dossier with its separate terminal result contract.';
function pilotFor(f:Paid, replyChars:number) {
  const old=f.store.get<ReaderPilot>('reader-pilot:p');
  return configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:f.environment.value.reviewer.model,effort:f.environment.value.reviewer.effort,
      command:f.environment.value.reviewer.command,speed:'inherited'},agentCommand:f.environment.value.reviewer.command,
    maxRequestChars:100000,maxReadChars:20000,maxReplyChars:replyChars,maxCalls:100,maxReportedTokens:100000,
    physicalLimits:{maxRequestChars:100000,maxReplyChars:replyChars,basis:'Measured dossier terminal response'}},old?.revision??0);
}
async function envelope(f:Paid, packet:DossierAssessmentPacket, store=f.store,
  context:unknown={dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT},
  capacity?:Record<string,any>, pilot?:Revision<ReaderPilot>, limit=30000) {
  return prepareDossierResearchEnvelope(f.environment.value.reviewer,{...f.environment.value,requestCapacityChars:limit},instruction,
    context,{store,draftId:f.draft.id,questionId:f.v.plan.id,purpose:'dossier-assessor',...(pilot?{pilot}:{})},capacity);
}
function archiveBytes(f:Paid, built:Awaited<ReturnType<typeof envelope>>, packet:DossierAssessmentPacket, store=f.store, modern=true, pages=true) {
  const wire=JSON.parse(built.input), body=archivedContext(store,store.get<DiscoveryDraft>(f.draft.id)!,wire.subject.working.archive).body;
  assert.equal(canonical(wire),canonical({...built.envelope,subject:built.subject}));
  assert.ok(built.input.length<=built.requestLimit);assert.deepEqual(body.dossierPacket,packet);
  assert.deepEqual(wire.subject.dossierSubject,packet.subject);assert.equal(wire.subject.question,undefined);
  assert.equal(wire.subject.assessmentDelivery.dispatch,'unavailable');
  assert.deepEqual(wire.subject.resultCapacity.forms.map((form:any)=>form.kind),modern?[...DOSSIER_REPLY_FORMS]:['read_context']);
  requirePacketMaterialDelivery(wire.subject,wire.subject.working.archive,(ref,pointer)=>
    contextValue(archivedContext(store,store.get<DiscoveryDraft>(f.draft.id)!,ref),pointer));
  for(const field of modern?['dossierPacket','dossierReplyContract']:['dossierPacket']) {
    if(pages) {
      let encoded='',offset=0;
      do {const page=contextPage(body[field],{offset,limit:197,encoding:'canonical-json'});
        encoded+=page.value;offset=page.page!.next??-1;}while(offset!==-1);
      assert.equal(encoded,canonical(field==='dossierPacket'?packet:dossierReplyContract(packet)));
    }
    if(wire.subject[field]===undefined)assert.ok(wire.subject.working.materialAddresses.some((a:any)=>a.field===field));
  }
  if(modern) {
    assert.equal(body.dossierResultTransport,DOSSIER_RESULT_TRANSPORT);
    assert.deepEqual(body.dossierReplyContract,dossierReplyContract(packet));
    assert.equal(wire.subject.resultCapacity.mandatory.projection.subject.dossierReplyContract.schemaHash,
      hashJson(dossierReplyContract(packet).schema));
  }
  return wire.subject.resultCapacity as ResearchResultCapacity;
}

for(const model of [false,true])test(`6.4 result transport: real ${model?'model':'owner'} selected; full schema, reply boundary, historic old/new and exact capacity`,async t=>{
  const f=await completed(t,model?'model':'owner');
  const saved=produceSelectedDossier(f.store,'p',f.input),packet=await prepareDossierAssessmentSubject(f.store,'p',reference(saved.record));
  assert.equal(packet.route.decision!.kind,model?'discovery-variant-model-decision':'discovery-variant-owner-decision'); // the seed of this route
  const result=replyFor(packet),replyChars=JSON.stringify(result).length,pilot=pilotFor(f,replyChars);
  const before=money(f.store),wireBefore=f.wires(),heads=all(f.store);
  const built=await envelope(f,packet,f.store,undefined,undefined,pilot),capacity=archiveBytes(f,built,packet);
  onlyNewArchives(heads,all(f.store)); // all other heads/history remain exact
  assert.deepEqual(money(f.store),before);assert.deepEqual(f.wires(),wireBefore);
  assert.equal(built.subject.responseOutputLimit.replyChars,replyChars);
  assert.ok(capacity.forms.every(form=>form.specialLimits!.physicalReplyChars===replyChars));
  const passed=(await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,result)))!;
  assert.equal(passed.terminal,true);assert.equal(passed.kind,'dossier_supported');assert.ok(passed.measurement.fits);
  assert.deepEqual(passed.projection,await checkDossierAssessmentResult(f.store,'p',packet.subject,result));
  assert.deepEqual(passed.measurement,measureResearchResult(capacity,'dossier_supported',result));
  const physicalReply=(research:unknown)=>projectResearchPhysicalReply(JSON.stringify({protocol:'omg-agent/v1',
    requestId:built.envelope.requestId,research}),built.envelope.requestId,0,'',replyChars);
  assert.deepEqual(physicalReply(result).payload,result);
  const over=structuredClone(result);over.reasons[0]+='x';
  assert.equal(physicalReply(over).error,'budget_transport_limit');
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,over),true);
  const tiny=pilotFor(f,1);
  await unchanged(f,f.store,()=>envelope(f,packet,f.store,undefined,undefined,tiny),true);
  // The roomier pilot changes only the capacity: this archive is the same era, the same packet and the same door as `built`, whose pages
  // were reassembled above field by field, so they are not paged again here; every other check of the archive runs.
  const roomy=pilotFor(f,1000000),room=await envelope(f,packet,f.store,undefined,undefined,roomy),roomCapacity=archiveBytes(f,room,packet,f.store,true,false);
  const addressed=replyFor(packet,'return');
  const returned=await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,addressed));
  assert.equal(returned!.kind,'dossier_return');assert.deepEqual(returned!.projection!.packet,packet);
  for(const response of [{action:'assessment_checkpoint',dossierSubject:packet.subject,notes:['Retain the exact review position']},
    {action:'read_context',record:room.subject.working.archive,pointer:'/body/dossierPacket',page:{offset:0,limit:197,encoding:'canonical-json'}},
    {action:'read_context',record:room.subject.working.archive,pointer:'/body/dossierPacket/materials',purpose:'Read the saved inventory',page:{offset:0,limit:1}}]) {
    const continued=await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,response));
    assert.equal(continued!.terminal,false);assert.equal(continued!.projection,null);
  }
  const boundary=structuredClone(result),allowed=roomCapacity.forms.find(form=>form.kind==='dossier_supported')!.maxResultChars;
  boundary.reasons[0]+='x'.repeat(allowed-JSON.stringify(boundary).length);
  assert.equal(JSON.stringify(boundary).length,allowed);
  const atLimit=await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,boundary));
  assert.equal(atLimit!.measurement.requiredChars,roomCapacity.envelopeLimitChars);
  boundary.reasons[0]+='x';
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,boundary),true);
  const oversized=structuredClone(result);oversized.reasons=['x'.repeat(roomCapacity.envelopeLimitChars)];
  assert.equal(measureResearchResult(roomCapacity,'dossier_supported',oversized).fits,false);
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,roomCapacity,oversized),true);
  await unchanged(f,f.store,()=>envelope(f,packet,f.store,{dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,
    physicalReplyLimit:9999999,responseOutputLimit:{replyChars:9999999}},undefined,pilot),true);
  assert.equal((archivedContext(f.store,f.store.get<DiscoveryDraft>(f.draft.id)!,built.subject.working.archive).body as any)
    .responseOutputLimit.replyChars,replyChars);
  const old=await envelope(f,packet,f.store,{dossierSubject:packet.subject});archiveBytes(f,old,packet,f.store,false);
  const late=await deep(f,'q-market',[claim(f,'q-market','market','New snapshot with later material')]);
  const mr=await assess(f,late,'unknown',false);const second=produceSelectedDossier(f.store,'p',f.input);
  const other=await prepareDossierAssessmentSubject(f.store,'p',reference(second.record));
  assert.notEqual(other.subject.identity,packet.subject.identity);
  await unchanged(f,f.store,()=>envelope(f,other,f.store,undefined,capacity),true);
  applyDiscoveryAssessment(f.store,'p',reference(mr));revise(f);modeOf(f.store,model?'questions':'bypass');nextPlan(f,f.store);
  // The historical fixed point: after every later head, the old subject reads exactly as saved on the hot and on a cold Store, and
  // each block changes no head or revision, no paid call and no wire.
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    await fixedPoint(f,store,async()=>{
      for(const record of [old.subject.working.archive,built.subject.working.archive])await unchanged(f,store,async()=>
        assert.deepEqual(await requireDossierTransportArchive(store,'p',record,packet.subject),packet));
      await unchanged(f,store,async()=>assert.deepEqual(await checkDossierResearchReply(store,'p',packet.subject,capacity,result),passed));
      // Today's larger pilot never changes the old saved physical bound.
      await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,capacity,over),true);
    });
  }
});

test('6.4 result transport: full rejected/unassessed/unknown and blocking sides; malformed, foreign and truncated contracts refuse read-only',async t=>{
  const f=await completed(t,'owner'),entries=f.entries,target=addresses(entries.industry)[0]!;
  const rejected=await deep(f,'q-market',[{...(claim(f,'q-market','market','Rejected explicit counterargument') as Record<string,Json>),
    contradicts:[target],refutedBy:[target]} as unknown as Json]);await assess(f,rejected,'rejected');
  await deep(f,'q-market',[{...(claim(f,'q-market','market','Unassessed addressed unknown') as Record<string,Json>),kind:'unknown',
    basis:{origin:'Saved gap',unknownId:'result-transport-gap',question:'Which deployment?',affects:['deployment'],consumer:'feasibility',
      blocksCurrentStage:false,moment:'feasibility',closeCriterion:'Identify deployment'}} as unknown as Json]);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference(produceSelectedDossier(f.store,'p',f.input).record));
  assert.ok(packet.materials.some(m=>m.status==='rejected'));assert.ok(packet.materials.some(m=>m.status==='unassessed'));
  assert.ok(packet.unknowns.length);assert.ok(packet.contradictions.length);
  const built=await envelope(f,packet),capacity=archiveBytes(f,built,packet),result=replyFor(packet,'return');
  const supported=replyFor(packet);const truncated=structuredClone(result);truncated.inventory.contradictions[0]!.sides.pop();
  const noMaterial=structuredClone(result);noMaterial.inventory.materials.pop();
  const foreign=structuredClone(result);foreign.subject={...result.subject,identity:'foreign'};
  const basis=structuredClone(result);basis.quality.roles.bases=[{record:{...packet.manifest.ref,hash:'0'.repeat(64)}}];
  const malformed=[null,{}, {...result,contract:null},{...result,contract:'unknown'},foreign,basis,truncated,noMaterial,supported,
    {...result,action:'assessment_checkpoint'}, {action:'assessment_checkpoint',notes:['Lost exact subject']}];
  const contexts=[{},{dossierSubject:null},{dossierSubject:packet.subject,dossierResultTransport:null},
    {dossierSubject:packet.subject,dossierResultTransport:'unknown'}, {dossierSubject:packet.subject,dossierReplyContract:dossierReplyContract(packet)},
    {dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,assessmentSubject:{}},
    {dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT,dossierReplyContract:null}];
  const foreignCapacities=[(c:any)=>{c.bindings.dossierSubject.identity='foreign'},(c:any)=>{c.forms.pop()},
    (c:any)=>{c.mandatory.projection.subject.dossierReplyContract.schemaHash='foreign'},
    (c:any)=>{c.forms[0].specialLimits.physicalReplyChars=999999}].map(change=>{const bad=structuredClone(capacity);change(bad);return bad;});
  // The counterfeit archives are honestly content-addressed records, saved once before the loops; every loop then reads all of them.
  const original=f.store.get<any>(built.subject.working.archive.id,1)!;
  const counterfeits=[(b:any)=>{b.dossierReplyContract.schema.oneOf=[]},(b:any)=>{b.dossierResultTransport=null},
    (b:any)=>{delete b.dossierReplyContract},(b:any)=>{b.resultCapacity.forms.pop()},(b:any)=>{b.resultCapacity.mandatory={}},
    (b:any)=>{b.resultCapacity.mandatory=null},
    ...[null,[],0,'projection'].map(value=>(b:any)=>{b.resultCapacity.mandatory={projection:value};}),
    (b:any)=>{delete b.dossierReplyContract;delete b.dossierResultTransport},(b:any)=>{b.dossierPacket.contradictions[0].sides.pop()}].map(change=>{
    const value=structuredClone(original.value);change(value.body);const id=`research-context:${hashJson(value)}`;
    return reference(f.store.get(id)??f.store.write({id,kind:'research-context',expected:0,value}));});
  // Hot and cold, one fixed-point block each: every row calls the real door and refuses inside its own window (stamp, paid calls and
  // wire unchanged), and the block as a whole leaves every head and revision exactly as they were.
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    await fixedPoint(f,store,async()=>{
      const accepted=await unchanged(f,store,()=>checkDossierResearchReply(store,'p',packet.subject,capacity,result));
      assert.equal(accepted!.projection!.packet.contradictions.length,packet.contradictions.length);
      await untouched(f,store,'malformed replies',malformed.map(response=>()=>checkDossierResearchReply(store,'p',packet.subject,capacity,response)));
      await untouched(f,store,'envelope contexts',contexts.map(context=>()=>envelope(f,packet,store,context)));
      await untouched(f,store,'foreign capacities',foreignCapacities.flatMap(bad=>[()=>checkDossierResearchReply(store,'p',packet.subject,bad,result),
        ()=>envelope(f,packet,store,undefined,bad)]));
      await untouched(f,store,'counterfeit archives',counterfeits.map(fake=>()=>requireDossierTransportArchive(store,'p',fake,packet.subject)));
      await untouched(f,store,'raw research call',[()=>researchCall(f.environment.value.reviewer,f.environment.value,instruction,
        {dossierSubject:packet.subject,dossierResultTransport:DOSSIER_RESULT_TRANSPORT},undefined,
        {store,draftId:f.draft.id,questionId:f.v.plan.id,purpose:'dossier-assessor'})]);
    });
  }
});

test('6.4 result transport: real nonempty partial preserves reasons and quality without becoming complete',async t=>{
  const f=await paid(t,(snapshot:Ref)=>({action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds:[snapshot]}],
    searchLimits:['Saved sweep'],unknowns:['Demand unknown']}),true);
  const none=f.store.list<VariantNone>('discovery-variant-none')[0]!;
  const handoff=await publishVariantHandoff(f.store,'p',{draft:reference(f.store.get(f.draft.id)!),result:reference(none),decision:null,scope:null,earlyLimit:false});
  const packet=await prepareDossierAssessmentSubject(f.store,'p',reference((await producePartialDossier(f.store,'p',reference(handoff.record))).record));
  const built=await envelope(f,packet),capacity=archiveBytes(f,built,packet),result=replyFor(packet);
  assert.equal(packet.manifest.value.completeness,'partial');assert.ok(packet.manifest.value.reasons.length);
  assert.ok(packet.materials.some(m=>m.status==='rejected'));assert.equal(packet.route.scope,null);
  const checked=(await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,result)))!;
  assert.equal(checked.projection!.completeness,'partial');
  const returned=replyFor(packet,'return');returned.return!.targets=[{partialReason:0}];
  await unchanged(f,f.store,()=>checkDossierResearchReply(f.store,'p',packet.subject,capacity,returned));
  modeOf(f.store,'bypass');nextPlan(f,f.store);
  const corrupted=[
    (c:any)=>{delete c.mandatory;},
    ...[null,[],0,'minimum',{}].map(value=>(c:any)=>{c.mandatory=value;}),
    (c:any)=>{delete c.mandatory.projection;},
    ...[null,[],0,'projection',{}].map(value=>(c:any)=>{c.mandatory={projection:value};}),
    ...[null,[],0,'subject'].map(value=>(c:any)=>{c.mandatory={projection:{subject:value}};}),
    (c:any)=>{c.mandatory={archive:null};},
    (c:any)=>{c.mandatory={projection:{subject:{}},archive:{}};},
    (c:any)=>{c.bindings=null;},
    (c:any)=>{c.forms=null;}
  ].map(damage=>{const corrupt=structuredClone(capacity);damage(corrupt);return corrupt;});
  for(const store of [f.store,new Store(f.store.path)]) {
    if(store!==f.store)t.after(()=>store.close());
    await fixedPoint(f,store,async()=>{
      await unchanged(f,store,async()=>assert.deepEqual(await checkDossierResearchReply(store,'p',packet.subject,capacity,result),checked));
      await untouched(f,store,'absent capacities',[undefined,null,[],0,'capacity'].map(absent=>()=>checkDossierResearchReply(store,'p',packet.subject,absent as any,result)));
      await untouched(f,store,'corrupted capacities',corrupted.map(corrupt=>()=>checkDossierResearchReply(store,'p',packet.subject,corrupt,result)));
      await unchanged(f,store,async()=>assert.deepEqual(await requireDossierTransportArchive(store,'p',built.subject.working.archive,packet.subject),packet));
    });
  }
});

test('6.4 result transport: two copies planted from one completed seed share no database, adapter, reply, wire, Environment head or Store and keep its history exactly',async t=>{
  const one=await completed(t,'owner'),two=await completed(t,'owner');
  assert.notEqual(one.root,two.root);assert.notEqual(one.store.path,two.store.path);assert.notEqual(one.settings,two.settings);
  assert.notEqual(one.environment.value.workspace,two.environment.value.workspace);
  assert.notDeepEqual(one.environment.value.implementer.command,two.environment.value.implementer.command);
  // The history is the seed's, byte for byte; only the Environment head is new, and its first revision still names the seed's directory.
  for(const ref of [one.input.scope,one.input.plan,reference(one.scopeRecord),reference(one.entries.industry.result.attempt),reference(one.entries.market.result.binding)])
    assert.deepEqual(one.store.get(ref.id,ref.revision),two.store.get(ref.id,ref.revision));
  const first=one.store.get<any>('environment:p',1)!;
  assert.notEqual(first.value.workspace,one.environment.value.workspace);
  assert.deepEqual(first,two.store.get<any>('environment:p',1)!);
  // A write, a reply file and a real call of one copy never reach the other.
  one.store.write({id:'seed-copy:probe',kind:'seed-probe',expected:0,value:{copy:'one'}});
  const cold=new Store(two.store.path);t.after(()=>cold.close());
  assert.equal(two.store.get('seed-copy:probe'),null);assert.equal(cold.get('seed-copy:probe'),null);
  one.reply({marker:'one'});two.reply({marker:'two'});
  assert.deepEqual(JSON.parse(readFileSync(one.settings,'utf8')).reply,{marker:'one'});
  assert.deepEqual(JSON.parse(readFileSync(two.settings,'utf8')).reply,{marker:'two'});
  one.reply(undefined);two.reply(undefined);
  const wires=[one.wires().length,two.wires().length],calls=[one.store.list('model-call').length,two.store.list('model-call').length];
  await researchCall(one.environment.value.implementer,one.environment.value,'Calibrate once more',{},undefined,
    {store:one.store,draftId:one.calibration.draft.id,questionId:one.calibration.question.id,purpose:'analyst'});
  assert.deepEqual([one.wires().length,two.wires().length],[wires[0]!+1,wires[1]!]);
  assert.deepEqual([one.store.list('model-call').length,two.store.list('model-call').length],[calls[0]!+1,calls[1]!]);
});
