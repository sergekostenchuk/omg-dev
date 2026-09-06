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
 const saved=engine.execute({type:'configure-saved-synthesis',project,question:question.id,expected:store.get(`saved-synthesis:${question.id}`)?.revision??0});
 const citations=[...new Map(saved.value.checkpoints.flatMap(ref=>store.get(ref.id,ref.revision).value.observations.map(o=>({source:o.source,selector:o.selector}))).map(c=>[JSON.stringify(c),c])).values()];
 const sourcesBefore=store.list('source').length,log=join(out,'envelopes.ndjson'),adapter=join(out,'fixture.mjs');
 writeFileSync(adapter,`import{readFileSync,appendFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),c=r.subject;appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
const citations=${JSON.stringify(citations)};let research;
if(c.role==='reader'||c.dispatchMode==='planning')throw Error('Recovery cannot buy another reader or plan');
if(c.role==='assess-answer')research=c.evidencePage.end<c.evidencePage.total?{action:'assessment_checkpoint',notes:['Fixture checked this saved evidence page']}:{verdict:'supported',reasons:[]};
else if(!c.synthesisPage.complete)research={action:'checkpoint',question:c.question.id,value:{fixtureOnly:true,savedFindingsProcessedThrough:c.synthesisPage.end},unresolved:['Compose remaining saved findings'],citations};
else research={action:'answer',question:c.question.id,value:{applicability:'applicable',reason:'Recorded fixture only, not a real research conclusion',facts:[],designs:[{id:'fixture-result',decision:'Fixture output from saved findings',benefit:'Validate recovery transport',consumer:'n-state'}],gaps:[]},citations};
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
