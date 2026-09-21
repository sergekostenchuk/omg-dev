// Recovers the paused question on an online SQLite copy, using recorded citations
// and a deterministic protocol adapter. No provider or new source read is used.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../dist/src/storage/store.js';
import { ProductEngine } from '../dist/src/product/engine.js';
import { configureReaderPilot, pilotEnvironment } from '../dist/src/discovery/reader-pilot.js';
import { reference } from '../dist/src/pipeline/contracts.js';
import { hashJson } from '../dist/src/canonical.js';
const [sourcePath,outPath]=process.argv.slice(2);
if(!sourcePath||!outPath)throw Error('Usage: node scripts/continuation-dry-run.mjs SOURCE_SQLITE NEW_OUTPUT_DIRECTORY');
const out=resolve(outPath);mkdirSync(out,{recursive:false});
const original=new DatabaseSync(resolve(sourcePath),{readOnly:true});
try{await backup(original,join(out,'copy.sqlite'));}finally{original.close();}
const store=new Store(join(out,'copy.sqlite')),engine=new ProductEngine(store),project='omg-live';
try{
 const question=store.list('question').find(q=>q.value.projectId===project&&q.value.level==='R2'&&q.value.spec.field==='contractsAndConsumers'&&q.value.status==='open');
 if(!question)throw Error('The copy has no paused contractsAndConsumers question');
 const saved=store.get(`saved-synthesis:${question.id}`);
 if(!saved)throw Error('Recovery must use the already selected saved checkpoints');
 const sourcesBefore=store.list('source').length,log=join(out,'envelopes.ndjson'),adapter=join(out,'fixture.mjs');
 writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
const fail=m=>{throw Error(m)},read=(record,pointer)=>({action:'read_context',record,pointer});let research;
if(c.role==='reader'||c.dispatchMode==='planning')fail('Recovery cannot buy another reader or plan');
if(!c.question.schema?.properties?.designs)fail('Response contract absent from this stateless packet');
const originals=(c.contextWorkspace??[]).filter(x=>x.record.id.startsWith('research-checkpoint:'));
if(c.role==='assess-answer'){
 const text=c.observations.length?JSON.stringify(c.observations):c.evidencePage.text;
 if(!text||!c.candidatePage)fail('The assessor needs actual evidence and the candidate');
 if(!c.candidatePage.complete||!c.evidencePage.complete)research={action:'assessment_checkpoint',notes:[JSON.stringify({evidenceChars:text.length,candidateChars:c.candidatePage.end})]};
 else {if(!c.value?.designs?.length||c.value.designs.some(d=>!d.decision||!d.consumer))fail('The assessor cannot validate an absent candidate');research={verdict:'supported',reasons:[]};}
}else {
 const pieces=c.selectedContext??[];
 const savedEvidence=pieces.flatMap(p=>p.evidence??[]);
 if(originals.length<2){
  const next=savedEvidence.find(e=>!originals.some(x=>x.record.id===e.original.record.id&&x.pointer===e.original.pointer));
  if(!next)fail('Direct addresses to saved observations are absent');research=read(next.original.record,next.original.pointer);
 }else{
  if(originals.some(x=>!x.value?.source||!x.value?.selector||!x.value?.value))fail('Two source operands must coexist, not only their addresses');
  if(c.materialPage)fail('Fixture requires full proposal operands; it cannot pretend to interpret an incomplete JSON fragment');
  const prior=(c.conclusions??[]).flatMap(n=>n.proposal?.value?.designs??[]);
  const additions=pieces.flatMap(p=>p.proposal?.value?.designs?.slice(0,1)??[]);
  const designs=[...new Map([...prior,...additions].map(d=>[d.id,d])).values()];
  if(!designs.length)fail('No supplied saved findings to combine');
  const citations=originals.map(x=>({source:x.value.source,selector:x.value.selector}));
  research={action:c.synthesisPage.complete?'answer':'checkpoint',question:c.question.id,
   value:{applicability:'applicable',reason:'Transport fixture combining supplied saved design proposals; no claim of completed real research',facts:[],designs,gaps:[]},citations,
   ...(!c.synthesisPage.complete?{unresolved:['Combine the remaining saved proposals']}:{})};
 }
}
console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:100,outputTokens:25,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const old=store.get(`reader-pilot:${project}`),{projectId:_id,...settings}=old.value;
 const cmd={executable:process.execPath,args:[adapter]};
 const pilot=configureReaderPilot(store,engine.environments,project,{...settings,agentCommand:cmd,reader:{...settings.reader,command:cmd},maxContinuationChars:100000},old.revision);
 const env=pilotEnvironment(engine.environments.get(project).value,pilot.value);
 for(const [purpose,role] of [['analyst',env.implementer],['assessor',env.reviewer]])store.write({id:`model-call:continuation-fixture-${purpose}`,kind:'model-call',expected:0,
  value:{projectId:project,draftId:'fixture',purpose,requestId:purpose,startedAt:0,finishedAt:1,status:'succeeded',requested:role,confirmed:{model:null,effort:null,speed:null},request:{chars:1000,bytes:1000,hash:hashJson(purpose)},response:null,usage:{inputTokens:100,outputTokens:25,cachedInputTokens:0,reasoningOutputTokens:0},usageSource:'adapter',error:null}});
 const run=await engine.researcher.run(project,question.value.draftId,1);
 const wire=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(store.get(question.id).value.status,'answered',JSON.stringify(run.value));
 assert.equal(store.list('source').length,sourcesBefore);
 const initialByRole={};
 for(const e of wire){
  assert.ok(e.subject.continuation);
  const role=e.subject.continuation.role;
  if(e.subject.continuation.kind==='initial')initialByRole[role]=(initialByRole[role]??0)+1;
  else {assert.ok(JSON.stringify(e).length<=100000);assert.ok(!e.subject.core);assert.ok(!e.subject.map);assert.ok(!e.subject.inventory);}
  assert.notEqual(role,'reader');assert.notEqual(role,'reading-planner');
 }
 assert.ok(Object.values(initialByRole).every(n=>n<=1));
 const report={fixtureOnly:true,paidCalls:0,question:question.id,checkpoints:saved.value.checkpoints.length,sourcesBefore,sourcesAfter:store.list('source').length,
  initialByRole,questionStatus:store.get(question.id).value.status,envelopes:wire.map(e=>({role:e.subject.continuation.role,kind:e.subject.continuation.kind,chars:JSON.stringify(e).length,page:((p)=>p?Object.fromEntries(Object.entries(p).filter(([k])=>k!=='text')):null)(e.subject.synthesisPage??e.subject.evidencePage)})),log};
 writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{store.close();}
