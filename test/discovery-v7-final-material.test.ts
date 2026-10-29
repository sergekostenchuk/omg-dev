import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { prepareArchiveParts } from '../src/discovery/request-parts.js';
import { readFinalCapacityProjection } from '../src/discovery/early-research-outcome.js';
import assert from 'node:assert/strict';
import { hashJson, canonical } from '../src/canonical.js';
import { finalMaterialArchive, finalMaterialProjection, finalMaterialAdmission, finalMaterialEra, packFinalMaterial, requireFinalMaterialDelivery, finalTechnicalLookup, FINAL_MATERIAL_CONTRACT } from '../src/discovery/final-material.js';
import { contextWorkspace, contextLookupKey, pendingContextWorkspace, requireCompleteContextPacket, recordContextPacket, type ContextCoverage } from '../src/discovery/context-workspace.js';
import { buildResearchResultCapacity } from '../src/discovery/research-delivery.js';
import { prepareResearchEnvelope } from '../src/discovery/research-protocol.js';
import type { Environment, RoleBinding } from '../src/runtime/environment.js';

const row=(id:string,kind:string,value:unknown)=>({ref:{id,revision:1,hash:hashJson(value)},kind,value});
function packet() {
  const main=row('claim','research-attempt',{claims:[{text:'Source supports the exact statement'}]});
  const call=row('paid','model-call',{request:{text:'technical'.repeat(160000)},status:'completed',error:null});
  const dossier:any={contract:'dossier-assessment-packet/v1',subject:{identity:'d6'},root:main,manifest:main,
    basis:{draft:main,frame:main,plan:main},route:{handoff:null},materials:[{container:main,assessment:null,value:{text:'The full claim'},status:'accepted'}],
    unknowns:[{unknown:{reason:'Unresolved risk'},material:{container:main,assessment:null,value:{text:'Unknown claim'}}}],
    contradictions:[{contradiction:{reason:'Conflicting source'},sides:[{container:main,assessment:null,value:{text:'Other side'}}],grounds:[main]}],grounds:[call]};
  const basis:any=Object.fromEntries(['session','application','call','request','response'].map(k=>[k,call.ref]));
  return {contract:'discovery-final-packet/v1',subject:{basis,identity:'final'},dossier,basis:dossier.basis,
    brief:{text:'Owner instruction and acceptance criterion'},assessment:row('assessment','dossier-assessment',{result:{packet:dossier,reasons:['Exact assessment reason']}}),
    terminal:{session:call,application:call,call,request:{text:'technical'.repeat(100000)},response:call}};
}
test('L34 final transport admits a large proven-shaped packet without duplicate execution bodies and preserves substantive fields',()=>{
  const p=packet(),material=finalMaterialProjection(p),request={contract:'discovery-final-result/v1',subject:p.subject,packet:p,schema:{type:'object'}};
  assert.ok(JSON.stringify(p).length>4000000);
  assert.ok(JSON.stringify(material).length<10000);
  assert.deepEqual(material.content.brief,p.brief);
  assert.deepEqual(material.content.dossier.packet.unknowns[0].unknown,p.dossier.unknowns[0].unknown);
  assert.deepEqual(material.content.assessment.value.result.reasons,['Exact assessment reason']);
  assert.deepEqual(material.content.terminal.call.record,p.subject.basis.call);
  assert.equal(material.content.assessment.value.result.packet.dossierHash,hashJson(p.dossier));
  const admission=finalMaterialAdmission(request);
  const capacity=buildResearchResultCapacity({operation:'final',generation:0,bindings:{},role:'synthesizer',purpose:'discovery-final',actionMode:'test',envelopeLimitChars:500000,
    mandatoryEnvelope:admission,forms:[{kind:'discovery_final'}]});
  assert.ok(capacity.forms[0]!.maxResultChars>490000);
  const corrupt:any=structuredClone(p);corrupt.assessment.value.result.packet={...p.dossier,unknowns:[]};
  assert.throws(()=>finalMaterialProjection(corrupt),{code:'discovery_final_material_invalid'});
});
test('L34 assessment and evidence keep the entire candidate, condition and offered material; era is explicit',()=>{
  const final=packet(),candidate={projection:{text:'Full candidate'},conditions:[{criterion:'Full condition'}]};
  const assessment:any={contract:'discovery-final-assessment-packet/v1',subject:{identity:'assess',candidate},candidate,final};
  assert.deepEqual(finalMaterialProjection(assessment).content.subject.candidate,candidate);
  assert.throws(()=>finalMaterialProjection({...assessment,candidate:{}}),{code:'discovery_final_material_invalid'});
  const evidence={contract:'discovery-condition-evidence-packet/v1',subject:{condition:{criterion:'Full criterion'}},bundle:candidate,material:[{claim:{text:'Full source quote'}}]};
  assert.equal(canonical(finalMaterialProjection(evidence).content),canonical(evidence));
  assert.equal(finalMaterialEra({}),false);assert.equal(finalMaterialEra({materialContract:FINAL_MATERIAL_CONTRACT}),true);
  assert.throws(()=>finalMaterialEra({materialContract:undefined}),{code:'discovery_final_material_invalid'});
  assert.throws(()=>finalMaterialEra({materialContract:'unknown'}),{code:'discovery_final_material_invalid'});
});

test('L34 a missing material, forged required address or early terminal cannot bypass substantive coverage; technical access stays exact',()=>{
  const p=packet();p.brief.text='A substantive instruction. '.repeat(6000);
  const request={contract:'discovery-final-result/v1',subject:p.subject,packet:p,schema:{type:'object'}};
  const archive={id:'invocation',revision:1,hash:'a'.repeat(64)},source={...archive,id:'prepared'};
  const wire:any={schema:request.schema,working:{archive,deliveryContract:'research-delivery/v1',instruction:'Read all pages'}};
  packFinalMaterial(wire,request,archive,source,60000,contextWorkspace());
  assert.ok(JSON.stringify(wire).length<=60000);assert.ok(wire.materialDelivery[0].served.next);
  assert.equal(Object.hasOwn(wire.request,'subject'),false);
  assert.equal(Object.hasOwn(wire.request,'schema'),false);
  assert.equal(wire.request.admission.hash,hashJson(finalMaterialAdmission(request)));
  requireFinalMaterialDelivery(wire,request,source);
  assert.throws(()=>requireCompleteContextPacket(contextWorkspace(),wire),{code:'research_context_incomplete'});
  for(const change of [(x:any)=>delete x.working.deliveryContract,(x:any)=>delete x.working.materialPaging,(x:any)=>delete x.working.materialAddresses,(x:any)=>x.working.materialAddresses[0].record.id='other',
    (x:any)=>x.working.materialAddresses[0].total=1,(x:any)=>x.request.packetHash='0'.repeat(64),
    (x:any)=>x.request.admission.record.id='other',(x:any)=>x.schema={type:'string'},(x:any)=>x.subject={identity:'other'}]){
    const bad=structuredClone(wire);change(bad);assert.throws(()=>requireFinalMaterialDelivery(bad,request,source),{code:'discovery_final_material_invalid'});
  }
  assert.equal(finalTechnicalLookup(wire,request,{record:archive,pointer:'/body/request/packet/terminal/call'}),true);
  assert.equal(finalTechnicalLookup(wire,request,{record:source,pointer:'/body/request/packet/terminal/call'}),false);
  assert.equal(finalTechnicalLookup(wire,request,{record:archive,pointer:'/body/request/packet/brief'}),false);
});

test('L34 shared capacity reader requires the saved era, exact address and complete link between original, material and admission',t=>{
  const root=mkdtempSync(join(tmpdir(),'omg-l34-capacity-')),store=new Store(join(root,'state.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const p=packet(),request={contract:'discovery-final-result/v1',subject:p.subject,packet:p,schema:{type:'object'}};
  const ref={id:'basis',revision:1,hash:'a'.repeat(64)},metadata={projectId:'p',draft:ref,question:ref};
  const save=(body:Record<string,any>)=>{const staged=prepareArchiveParts(store,metadata,body);store.writeMany(staged.writes,staged.guards);return staged.archive;};
  const body=finalMaterialArchive(request,true),at=save(body);
  assert.deepEqual(readFinalCapacityProjection(store,at,'/body/admission'),finalMaterialAdmission(request));
  assert.deepEqual(readFinalCapacityProjection(store,at,'/body/request'),request);
  for(const change of [(x:any)=>delete x.admission.materialContract,(x:any)=>x.admission.materialContract='unknown',
    (x:any)=>delete x.finalMaterial,(x:any)=>x.finalMaterial.content.brief.text='Changed substantive instruction',
    (x:any)=>x.admission.packetHash='b'.repeat(64)]){
    const bad=structuredClone(body);change(bad);const wrong=save(bad);
    assert.throws(()=>readFinalCapacityProjection(store,wrong,'/body/admission'),{code:'research_capacity_invalid'});
  }
  assert.throws(()=>readFinalCapacityProjection(store,{...at,hash:'b'.repeat(64)},'/body/admission'),{code:'research_capacity_invalid'});
  assert.throws(()=>readFinalCapacityProjection(store,at,'/body/other'),{code:'research_capacity_invalid'});
  const old=save({request});assert.deepEqual(readFinalCapacityProjection(store,old,'/body/request'),request);
  assert.throws(()=>readFinalCapacityProjection(store,old,'/body/admission'),{code:'research_capacity_invalid'});
});

test('L35 physical preflight counts capacity and wrapper before paging a large final assessment',()=>{
  const p=packet();p.brief.text='The complete substantive instruction. '.repeat(30000);
  const candidate={verdict:'go',reason:'The entire candidate remains mandatory'};
  const assessment={contract:'discovery-final-assessment-packet/v1',subject:{candidate},candidate,final:p};
  const request={contract:'discovery-final-assessment-result/v1',subject:assessment.subject,packet:assessment,schema:{type:'object'}};
  const role:RoleBinding={actor:'assessor',model:'local',effort:'high',command:{executable:'unused',args:[]}};
  const env:Environment={projectId:'p',workspace:'/tmp',implementer:role,reviewer:role,fullCheck:{executable:'unused',args:[]},timeoutMs:1000};
  // Reproduce L35's measured capacity overhead, independently of material size.
  const capacity={bindings:{},envelopeLimitChars:500000,forms:[{kind:'assessment',schema:'s'.repeat(12215)}]};
  assert.throws(()=>prepareResearchEnvelope(role,env,'p'.repeat(471),{material:'x'.repeat(491337)},undefined,capacity,
    undefined,undefined,500000),{code:'pilot_request_limit'});
  const at={id:'exact-assessment',revision:1,hash:'a'.repeat(64)};
  let packed:any;
  const wire=prepareResearchEnvelope(role,env,'p'.repeat(471),{},undefined,capacity,undefined,undefined,500000,limit=>{
    packed={working:{archive:at,deliveryContract:'research-delivery/v1'}};
    packFinalMaterial(packed,request,at,at,limit-JSON.stringify({resultCapacity:capacity}).length-32,contextWorkspace());
    return {...packed,resultCapacity:capacity};
  });
  assert.ok(wire.input.length<=500000);
  const physical=JSON.parse(wire.input).subject;
  assert.deepEqual(physical.resultCapacity,capacity);
  requireFinalMaterialDelivery(physical,request,at);
  assert.ok(physical.materialDelivery[0].served.next>0);
  assert.throws(()=>requireCompleteContextPacket(contextWorkspace(),physical),{code:'research_context_incomplete'});
});

test('L34 pending context delivers the next exact uncovered interval without losing its original or repeating a prefix',()=>{
  const record={id:'exact-original',revision:1,hash:'a'.repeat(64)},pointer='/body/material';
  for(const value of ['0123456789',[0,1,2,3,4,5,6,7,8,9],{statement:'A complete original'}]){
    const result={record,pointer,value},key=contextLookupKey(result);
    const encoding=Array.isArray(value)?'array-items':typeof value==='string'?'utf16-string':'canonical-json';
    const unit=encoding==='array-items'?'items':'utf16';
    const total=typeof value==='object'&&!Array.isArray(value)?canonical(value).length:value.length;
    const coverage:ContextCoverage={address:hashJson({record,pointer,unit,encoding}),record,pointer,unit,encoding,total,ranges:[{offset:0,end:3},{offset:5,end:8}]};
    const workspace=contextWorkspace({entries:[{key,result}],sinceProgress:1,checkpointedKeys:[key],deliveryCoverage:[coverage]});
    const pending=contextWorkspace(pendingContextWorkspace(workspace)),lookup=pending.entries[0]!.result;
    assert.deepEqual(lookup.page,{offset:3,end:5,total,unit,next:5,...(encoding==='canonical-json'?{encoding:'canonical-json'}:{})});
    const original=typeof value==='string'||Array.isArray(value)?value:canonical(value);
    assert.deepEqual(lookup.value,original.slice(3,5));assert.deepEqual(pending.checkpointedKeys,[]);
    const wire:any={contextWorkspace:[lookup],contextIndex:[{key:contextLookupKey(lookup),record,pointer,page:lookup.page,chars:canonical(lookup.value).length}],
      working:{deliveryContract:'research-delivery/v1'}};
    const delivered=recordContextPacket(pending,wire);
    const next=pendingContextWorkspace({...workspace,deliveryCoverage:delivered.deliveryCoverage!}).entries[0]!.result;
    assert.equal(next.page!.offset,8);assert.equal(next.page!.end,total);
    assert.throws(()=>pendingContextWorkspace({...workspace,deliveryCoverage:[{...coverage,total:total+1}]}),{code:'research_context_invalid'});
  }
});

test('L34 overlapping paid lookups deliver one exact unread tail while retaining their originals and newest order',()=>{
  const record={id:'exact-original',revision:1,hash:'a'.repeat(64)},pointer='/body/material';
  const first={record,pointer,value:'0123456789'};
  const last={record,pointer,value:'23456789',page:{offset:2,end:10,total:10,unit:'utf16',next:null}};
  const other={record,pointer:'/body/other',value:'Another original'};
  const state=contextWorkspace({entries:[first,other,last].map(result=>({key:contextLookupKey(result),result})),sinceProgress:3,
    deliveryCoverage:[{address:hashJson({record,pointer,unit:'utf16',encoding:'utf16-string'}),record,pointer,
      unit:'utf16',encoding:'utf16-string',total:10,ranges:[{offset:0,end:6}]}]});
  const before=structuredClone(state),pending=pendingContextWorkspace(state);
  assert.equal(pending.entries.length,2);assert.deepEqual(pending.entries[0]!.result,other);
  assert.deepEqual(pending.entries[1]!.result,{record,pointer,value:'6789',page:{offset:6,end:10,total:10,unit:'utf16',next:null}});
  assert.deepEqual(state,before);assert.equal(state.entries.length,3);
});
