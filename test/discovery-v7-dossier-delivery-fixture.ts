import type { TestContext } from 'node:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { paid } from './discovery-v7-dossier-seed.js';
import { reference, type Ref } from '../src/pipeline/contracts.js';
import { publishVariantHandoff } from '../src/discovery/discovery-outcome.js';
import { producePartialDossier } from '../src/discovery/dossier-manifest.js';
import { prepareDossierAssessmentSubject } from '../src/discovery/dossier-assessment.js';
import { DOSSIER_QUALITY_DIMENSIONS } from '../src/discovery/research-model.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';

/** Real producers and a local adapter. No Source, paid result or classification is inserted by the fixture. */
export async function dossierDeliveryWorld(t:TestContext, repetitions=12000) {
  const f=await paid(t,(snapshot:Ref)=>({action:'no_variants',reasons:[{code:'bounded_search',message:'No bounded variant',grounds:[snapshot]}],
    searchLimits:['Saved sweep'],unknowns:['Demand unknown']}),true,'Required product constraints. '+ 'Never lose this substantive requirement. '.repeat(repetitions));
  const none=f.store.list('discovery-variant-none')[0]!;
  const handoff=await publishVariantHandoff(f.store,'p',{draft:reference(f.store.get(f.draft.id)!),result:reference(none),decision:null,scope:null,earlyLimit:false});
  const root=reference((await producePartialDossier(f.store,'p',reference(handoff.record))).record);
  const packet=await prepareDossierAssessmentSubject(f.store,'p',root),bases=[{record:packet.manifest.ref}];
  const terminal={contract:'dossier-assessment-result/v1',subject:packet.subject,verdict:'return',reasons:['Assess every substantive original'],
    quality:Object.fromEntries(DOSSIER_QUALITY_DIMENSIONS.map(key=>[key,{judgement:'adequate',reason:'Read exact material',bases}])),
    inventory:{materials:packet.materials.map(x=>x.address),unknowns:packet.unknowns.map(x=>x.unknown.claim),contradictions:[]},
    return:{targets:[{partialReason:0}],reason:'Retain the partial outcome',bases}};
  writeFileSync(f.settings,JSON.stringify({terminal}));
  writeFileSync(f.root+'/adapter.mjs',`import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const raw=readFileSync(0,'utf8'),r=JSON.parse(raw),path=${JSON.stringify(f.settings)},s=JSON.parse(readFileSync(path,'utf8'));
appendFileSync(${JSON.stringify(f.root+'/wire.ndjson')},raw+'\\n');
s.coverage??={};const key=(record,pointer)=>JSON.stringify([record.id,record.revision,record.hash,pointer]);
for(const f of [...r.subject.materialDelivery??[],...r.subject.contextDelivery??[]]) (s.coverage[key(f.original.record,f.original.pointer)]??=[]).push([f.served.offset,f.served.end]);
for(const f of r.subject.contextWorkspace??[]) if(f.page)(s.coverage[key(f.record,f.pointer)]??=[]).push([f.page.offset,f.page.end]);
let research;
if(!s.early)for(const address of r.subject.working.materialAddresses??[]){
 let offset=0;for(const [start,end] of (s.coverage[key(address.record,address.pointer)]??[]).sort((a,b)=>a[0]-b[0])){if(start>offset)break;offset=Math.max(offset,end);}
 if(offset<address.total){research=s.read?{action:'read_context',record:address.record,pointer:address.pointer,page:{offset,limit:s.readLimit??16000,encoding:'canonical-json'}}:
 {action:'assessment_checkpoint',dossierSubject:s.terminal.subject,notes:['Continue the next exact required page']};break;}
}
research??=s.terminal;writeFileSync(path,JSON.stringify(s));
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:10,outputTokens:1,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const profile=configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',
    reader:{actor:'dossier-reader',model:f.environment.value.reviewer.model,effort:f.environment.value.reviewer.effort,command:f.environment.value.reviewer.command,speed:'inherited'},
    agentCommand:f.environment.value.reviewer.command,maxRequestChars:500000,maxReadChars:20000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:100000,
    physicalLimits:{maxRequestChars:500000,maxReplyChars:100000,basis:'Local L29 adapter'}},0);
  const start=f.wires().length;
  return {...f,packet,profile,terminal, sent:()=>f.wires().slice(start),
    settingsChange:(value:Record<string,unknown>)=>writeFileSync(f.settings,JSON.stringify({...JSON.parse(readFileSync(f.settings,'utf8')),...value}))};
}
