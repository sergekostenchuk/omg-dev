import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hashJson } from '../src/canonical.js';
import { dossierMaterialDictionary, restoreDossierMaterial, dossierMaterialProjection, DOSSIER_MATERIAL_CONTRACT } from '../src/discovery/dossier-material.js';
import { addressArchivedMaterials, serveArchivedMaterial, requirePacketMaterialDelivery } from '../src/discovery/research-delivery.js';
import { contextWorkspace, contextProgress, requireCompleteContextPacket } from '../src/discovery/context-workspace.js';
import type { Ref } from '../src/pipeline/contracts.js';

const ref = (id:string, value:unknown):Ref => ({id,revision:1,hash:hashJson(value as never)});
test('L29 dictionary preserves every record, classification and opaque record-shaped user value', () => {
  const value={text:'X'.repeat(10000)}, row={ref:ref('a',value),kind:'research-attempt',value};
  const opaque={ref:row.ref,kind:'user-data',value:'not a record slot'}, material={container:row,assessment:row,value:opaque,status:'rejected',address:{opaque}};
  const packet:any={contract:'dossier-assessment-packet/v1',subject:{identity:'test'},root:row,manifest:row,
    basis:{draft:row,frame:row,plan:row},route:{handoff:row,snapshot:null},coverage:null,materials:[material],
    unknowns:[{unknown:{opaque},material}],contradictions:[{contradiction:{opaque},sides:[material,material],grounds:[row]}],grounds:[row]};
  const dictionary=dossierMaterialDictionary(packet);
  assert.equal(dictionary.contract,DOSSIER_MATERIAL_CONTRACT); assert.equal(dictionary.records.length,1);
  assert.deepEqual(restoreDossierMaterial(dictionary),packet);
  assert.deepEqual(dictionary.packet.materials[0].value,opaque);
  assert.ok(canonical(dictionary).length < canonical(packet).length/3);
  const truncated=structuredClone(dictionary);truncated.records=[];
  assert.throws(()=>restoreDossierMaterial(truncated),{code:'discovery_dossier_transport_invalid'});
  const masquerade=structuredClone(dictionary);masquerade.records[0]!.value={text:'changed'};
  assert.throws(()=>restoreDossierMaterial(masquerade),{code:'discovery_dossier_transport_invalid'});
});

test('L29 common paging traverses exact uncovered intervals, never repeats a prefix, keeps legacy default', () => {
  const value={records:['quoted " \\ \n '.repeat(9000)]}, archive=ref('research-context:full',value);
  const original=ref('research-context:material',value);
  let workspace=contextWorkspace(),sum=0,calls=0,last=0;
  const build=(coverage=workspace.deliveryCoverage??[],pageChars=12000)=>{
    const packet:any={dossierMaterial:value,contextWorkspace:[],contextIndex:[],working:{archive,deliveryContract:'research-delivery/v1',instruction:''}};
    const originals=addressArchivedMaterials(packet,archive,['dossierMaterial'],100000,()=>original,4096,{pageChars});
    serveArchivedMaterial(packet,originals,100000,1024,{coverage,pageChars});
    requirePacketMaterialDelivery(packet,archive,()=>value);
    return packet;
  };
  assert.throws(()=>requireCompleteContextPacket(workspace,build()),{code:'research_context_incomplete'});
  while(last<canonical(value).length){
    const packet=build(),fragment=packet.materialDelivery[0];
    assert.equal(fragment.served.offset,last); assert.ok(fragment.served.end>last);
    assert.ok(JSON.stringify(fragment).length<=12000);sum+=JSON.stringify(packet).length;calls++;
    last=fragment.served.end;workspace=contextProgress(workspace,packet);
  }
  const finished=build();assert.equal(finished.materialDelivery,undefined);
  requireCompleteContextPacket(workspace,finished);
  assert.ok(calls>3);assert.ok(sum<canonical(value).length*2);
  const foreign=workspace.deliveryCoverage!.map(item=>({...item,address:'foreign'}));
  assert.equal(build(foreign).materialDelivery[0].served.offset,0);
  const bad=workspace.deliveryCoverage!.map(item=>({...item,total:item.total+1}));
  assert.throws(()=>build(bad),{code:'research_context_invalid'});
  const legacy:any={contextWorkspace:[],contextIndex:[],working:{archive,deliveryContract:'research-delivery/v1',instruction:''},dossierMaterial:value};
  const originals=addressArchivedMaterials(legacy,archive,['dossierMaterial'],50000,()=>original);
  serveArchivedMaterial(legacy,originals,50000);assert.equal(legacy.materialDelivery[0].served.offset,0);
  assert.equal(legacy.working.materialPaging,undefined);
});


test('L29 technical projection keeps content by role, including content embedded in accounting records',()=>{
  const row=(kind:string,value:any,id=kind)=>({ref:ref(id,value),kind,value});
  const main=row('research-attempt',{claims:[{text:'Required source and statement'}]});
  const call=row('model-call',{request:{chars:9999},budget:{large:'accounting'},status:'failed',error:'Source could not establish the claim',sourceEvidence:{text:'Do not hide content'}});
  const ledger=row('research-budget-ledger',{assignments:[{tokens:100}],segment:'shared',meaningfulFutureField:{reason:'Keep unknown content'}});
  const run=row('research-run',{owner:{pid:123},turns:20,status:'paused',error:'Exact stop reason',ownerQuestion:{reason:'Need evidence'}});
  const material={container:main,assessment:null,value:{text:'Exact claim'},status:'unassessed',address:{claimId:'claim'}};
  const packet:any={contract:'dossier-assessment-packet/v1',subject:{identity:'test'},root:main,manifest:main,
    basis:{draft:main,frame:main,plan:main},route:{handoff:null},coverage:null,materials:[material],unknowns:[{unknown:{claim:material.address},material}],
    contradictions:[{contradiction:{id:'c',resolution:{state:'resolved'}},sides:[material,material],grounds:[run]}],grounds:[call,ledger,run]};
  const full=dossierMaterialDictionary(packet),projection=dossierMaterialProjection(packet);
  assert.deepEqual(restoreDossierMaterial(full),packet);
  const technical=projection.records.filter(x=>'technical' in x);
  assert.equal(technical.length,2);
  for(const entry of technical){
    assert.ok('content' in entry);assert.ok(!Object.hasOwn(entry,'value'));
    assert.deepEqual(packet.grounds[Number(entry.technical.pointer.split('/').at(-1))].ref,entry.ref);
  }
  assert.deepEqual((technical.find(x=>x.kind==='model-call') as any).content.sourceEvidence,{text:'Do not hide content'});
  assert.equal((technical.find(x=>x.kind==='model-call') as any).content.error,'Source could not establish the claim');
  assert.deepEqual((technical.find(x=>x.kind==='research-budget-ledger') as any).content.meaningfulFutureField,{reason:'Keep unknown content'});
  assert.deepEqual(projection.records.find(x=>x.kind==='research-run'),run,'a resolution ground must stay complete');
  assert.deepEqual(projection.packet.materials[0].value,material.value);
  assert.deepEqual(projection.packet.unknowns[0].unknown,packet.unknowns[0].unknown);
});
