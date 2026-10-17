import { discoveryContext, discoveryOutcome } from '../src/discovery/discovery-outcome.js';
import type { DiscoveryDraft } from '../src/discovery/discovery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv} from 'ajv';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference, type Ref} from '../src/pipeline/contracts.js';
import {canonical, hashJson, type Json} from '../src/canonical.js';
import type {Question} from '../src/discovery/discovery.js';
import {REQUIREMENTS,UPSTREAM_STAGES,VERSION4_REQUIREMENTS,VERSION5_REQUIREMENTS,VERSION6_REQUIREMENTS,RESEARCH_CONTRACT_VERSION} from '../src/discovery/requirements.js';
import {contextValue,workingContext} from '../src/discovery/working-context.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {previewResearch} from '../src/discovery/research-preview.js';
import {continuationPrompt} from '../src/discovery/continuation-packet.js';
import {configureReaderPilot} from '../src/discovery/reader-pilot.js';
import {readBundle,readReaderResultAt} from '../src/discovery/reader.js';
import {readResearchConsumerTurn} from '../src/discovery/response-recovery.js';
import {readSynthesisSession} from '../src/discovery/synthesis-session.js';
import {currentUpstreamFixtureValue,preparedFeatures} from './product-fixture.js';
import {preparedField} from './preparation-fixture.js';
import {exampleGraph} from './graph-fixture.js';
import {enrichedGraph} from './enriched-graph-fixture.js';
import {designOf} from '../src/graph/builder.js';
import {DISCOVERY_ANALOGUES_PROMPTS} from '../src/discovery/preparation-contracts.js';
import {readDiscoveryBasisMaterial,researchPrerequisites} from '../src/discovery/research-context.js';

function fixture(t:test.TestContext, acceptedPrefix=false, changeValues?:(values:Record<string,Json>)=>void) {
 const root=mkdtempSync(join(tmpdir(),'omg-rs4-')),store=new Store(join(root,'state.sqlite')),engine=new ProductEngine(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 if(acceptedPrefix)preparedFeatures(engine,'p');
 else engine.execute({type:'create-project',project:'p',title:'Local protocol fixture'});
 const path=join(root,'adapter.mjs'),log=join(root,'wire.jsonl');
 const values:Record<string,Json>=Object.fromEntries(UPSTREAM_STAGES.flatMap(stage=>REQUIREMENTS[stage].map(s=>[s.field,preparedField('p',s.field)])));
 values['mapDesign']=designOf(enrichedGraph(exampleGraph('p'),'p',values['preparation'],values['conceptSections'])) as unknown as Json;
 changeValues?.(values);
 const source=engine.discovery.evidence.document('p','fixture',JSON.stringify(values),'application/json',0);
 writeFileSync(join(root,'values.json'),JSON.stringify(values));
 writeFileSync(path,`import{boundDiscoveryValue}from ${JSON.stringify(new URL('./preparation-fixture.js',import.meta.url).href)};
 import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';
 import assert from'node:assert/strict';
 const ds2Prompts=${JSON.stringify(changeValues ? DISCOVERY_ANALOGUES_PROMPTS : {})};
 const root=${JSON.stringify(root)},r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,q=s.question??s.questions?.[0],role=s.continuation.role;
 appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
 const file=root+'/counts.json',counts=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{},key=s.continuation.question+':'+role;
 const n=(counts[key]??0)+1;counts[key]=n;writeFileSync(file,JSON.stringify(counts));
 const mode=existsSync(root+'/mode')?readFileSync(root+'/mode','utf8'):'native',source=${JSON.stringify(reference(source))};let research;
 if(mode==='pause')research={action:'pause',reason:'Local envelope fixture'};
 else if(role==='reader')research={selections:s.sources.map(x=>({sourceIndex:x.sourceIndex,firstLine:x.lines[0][0],lastLine:x.lines.at(-1)[0]})),unresolved:[]};
 else if(role==='assessor'){
  if(ds2Prompts[q.field]){
   assert.equal(q.prompt,ds2Prompts[q.field]);
   assert.equal(s.candidatePage.complete,true);assert.equal(s.evidencePage.complete,true);
   const values=JSON.parse(readFileSync(root+'/values.json','utf8'));
   assert.deepEqual(s.value,boundDiscoveryValue(q.field,values[q.field],s.discoveryContext));
   const evidenceFile=root+'/evidence-'+encodeURIComponent(q.id)+'.json';
   if(s.evidencePage.offset===0){
    const delivered=s.evidencePage.text===undefined?s.observations:JSON.parse(s.evidencePage.text);
    writeFileSync(evidenceFile,JSON.stringify(delivered));
   }
   const evidence=JSON.parse(readFileSync(evidenceFile,'utf8'));assert.ok(evidence.length>0);
   if(q.field==='researchReport'){
    assert.match(s.value.openQuestions[0].reason,/аналогов не найдено/);
    assert.ok(JSON.stringify(evidence).includes(values.feasibilityEvidence.technology));
   }
   if(q.field==='verdict'){
    assert.equal(s.value.outcome==='go',values.feasibilityEvidence.compatibility!==null);
    if(s.value.outcome!=='go')assert.match(s.value.reason,/совместимость/);
   }
  }
  research=n===1?{action:'assessment_checkpoint',notes:['Inspect the supplied evidence and candidate.']}:{verdict:'supported',reasons:[]};
 }
 else if(role==='escalation-assessor')research={necessary:false,reason:'Fixture goal already supplies the choice'};
 else if(n===1)research={action:'read_source',source,start:0,end:${source.value.content.length}};
 else if(mode==='escalation')research={action:'need_owner',question:q.id,reason:'Fixture escalation only',searched:[source]};
 else research={action:'answer',question:q.id,value:boundDiscoveryValue(q.field,JSON.parse(readFileSync(root+'/values.json','utf8'))[q.field],s.discoveryContext),citations:[{source,selector:{kind:'json-pointer',pointer:ds2Prompts[q.field]&&q.field==='researchReport'?'/feasibilityEvidence':'/'+q.field}}]};
 console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const command={executable:process.execPath,args:[path]};
 const environment=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'medium',command},reviewer:{actor:'assessor',model:'fixture',effort:'medium',command},fullCheck:{executable:process.execPath,args:['--version']},timeoutMs:10000},0);
 const wires=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s)):[];
 return {root,store,engine,environment,source,values,wires,path,command};
}

function resolveAddress(store:Store,ref:Ref,pointer:string) {
 const record=store.get<any>(ref.id,ref.revision);assert.equal(record?.hash,ref.hash);
 return contextValue(record.value,pointer);
}
function assertPacket(store:Store,wire:any) {
 const s=wire.subject,c=s.continuation;
 for(const pointer of c.foundationPointers)resolveAddress(store,c.foundation,pointer);
 for(const section of s.working.sections)resolveAddress(store,s.working.archive,section.pointer);
 if(c.role==='reader') {assert.ok(s.sources.length);return;}
 const archive=store.get<any>(s.working.archive.id,s.working.archive.revision)!,q=store.get<Question>(archive.value.question.id,archive.value.question.revision)!;
 assert.equal(s.question.id,q.id);
 for(const [key,value] of Object.entries(q.value.spec))assert.deepEqual(s.question[key],value,`${q.value.spec.field}: ${key}`);
 if(s.question.schemaAddress)assert.deepEqual(resolveAddress(store,s.question.schemaAddress.record,s.question.schemaAddress.pointer),q.value.spec.schema);
}

test('RS4 real early-stage analyst and assessor producers retain their complete question and instructions in all five stages',async t=>{
 const f=fixture(t);
 for(const stage of UPSTREAM_STAGES) {
  const draft=f.engine.prepare('p',stage);
  if(stage==='concept'||stage==='specification') {
   const field=stage==='concept'?'conceptSections':'behaviorContracts';
   f.values[field]=currentUpstreamFixtureValue(f.engine,'p',field,f.values[field]!);
   writeFileSync(join(f.root,'values.json'),JSON.stringify(f.values));
  }
  for(const id of draft.value.questions) {
   const q=f.store.get<Question>(id)!;
   if(q.value.spec.kind==='fact')f.engine.discovery.fact(id,q.revision,reference(f.source),{kind:'json-pointer',pointer:'/'+q.value.spec.field});
   if(q.value.spec.kind==='decision')f.engine.discovery.decision(id,q.revision,'owner',f.values[q.value.spec.field]!);
  }
  const result:any=await f.engine.execute({type:'research-stage',project:'p',draftId:draft.id,maxTurns:30});
  assert.equal(result.status,'accepted',JSON.stringify(result));
 }
 const groups=new Map<string,any[]>();
 for(const wire of f.wires()) {
  assertPacket(f.store,wire);
  const key=wire.subject.continuation.question+':'+wire.subject.continuation.role;
  groups.set(key,[...(groups.get(key)??[]),wire]);
 }
 assert.equal(groups.size,32);
 for(const pair of groups.values()) {
  assert.equal(pair[0].subject.continuation.kind,'initial');assert.equal(pair[1].subject.continuation.kind,'continuation');
  assert.ok(pair[1].prompt.includes(pair[0].prompt),'role and evidence instructions survive');
  assert.equal(pair[1].subject.continuation.foundation.hash,pair[0].subject.working.archive.hash);
  assert.notEqual(pair[1].subject.continuation.current.hash,pair[0].subject.working.archive.hash);
 }
});

test('RS4 all 18 real early FieldSpecs survive both producer question shapes, including a selected non-first question',async t=>{
 const f=fixture(t,true);writeFileSync(join(f.root,'mode'),'pause');let count=0;
 for(const stage of UPSTREAM_STAGES) {
  const draft=f.engine.prepare('p',stage);
  for(const id of draft.value.questions)for(const shape of ['question','questions']) {
   const q=f.store.get<Question>(id)!,who={...f.environment.value.implementer,actor:stage+':'+q.id+':'+shape};
   const all=draft.value.questions.map(id=>({id,...f.store.get<Question>(id)!.value.spec}));
   const body={role:'research',stage,[shape]:shape==='question'?{id,...q.value.spec}:all,fields:{[q.value.spec.field]:null},
    ...(['concept','specification'].includes(stage) ? {
     discoveryBasisCatalogue:readDiscoveryBasisMaterial(f.store,draft.value).catalogue,
     ...(stage==='specification'?{prerequisites:researchPrerequisites(f.store,draft.value)}:{})
    }:{})};
   const audit={store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'};
   await researchCall(who,f.environment.value,'Exact forms: answer with citations:{source,selector}; fixture.',body,undefined,audit);
   const preview=await previewResearch(()=>researchCall(who,f.environment.value,'Exact forms: answer with citations:{source,selector}; fixture.',body,undefined,audit));
   const wire=JSON.parse(preview.input);assertPacket(f.store,wire);
   assert.equal(wire.subject.question.schemaAddress.pointer,shape==='question'?'/body/question/schema':`/body/questions/${draft.value.questions.indexOf(id)}/schema`);
   count++;
  }
 }
 assert.equal(count,36);
});

test('RS4 native escalation and public reader preserve their own material and address only their actual foundation',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'mode'),'escalation');
 const draft=f.engine.prepare('p','discovery');
 for(const id of draft.value.questions){const q=f.store.get<Question>(id)!;
  if(q.value.spec.kind==='fact')f.engine.discovery.fact(id,q.revision,reference(f.source),{kind:'json-pointer',pointer:'/'+q.value.spec.field});
  if(q.value.spec.kind==='decision')f.engine.discovery.decision(id,q.revision,'owner',f.values[q.value.spec.field]!);
 }
 for(let i=0;i<3;i++)await f.engine.researcher.run('p',draft.id,1);
 const esc=f.wires().filter(w=>w.subject.continuation.role==='escalation-assessor');
 assert.equal(esc.length,2);for(const wire of esc)assertPacket(f.store,wire);
 assert.ok(esc[1].prompt.includes(esc[0].prompt));assert.deepEqual(esc[1].subject.request,esc[0].subject.request);
 const q=f.store.get<Question>(draft.value.questions.find(id=>f.store.get<Question>(id)!.value.spec.kind==='design')!)!;
 const pilot=configureReaderPilot(f.store,f.engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'medium',speed:'inherited',command:f.command},agentCommand:f.command,maxCalls:20,maxReportedTokens:100000,maxRequestChars:100000,maxReadChars:100000,maxReplyChars:30000},0);
 for(let i=0;i<2;i++) {
  const source=f.engine.discovery.evidence.document('p','reader-'+i,'Exact line '+i+'\nException stays exact.','text/plain',0);
  const result=await readBundle(f.store,f.environment.value,pilot,reference(q),'Read exact '+i,[{source:reference(source),range:{start:0,end:source.value.content.length}}]);
  assert.equal(result.value.observations[0]!.value,source.value.content);
 }
 const readers=f.wires().filter(w=>w.subject.continuation.role==='reader');assert.equal(readers.length,2);
 for(const wire of readers){assertPacket(f.store,wire);assert.deepEqual(wire.subject.continuation.foundationPointers,[]);assert.equal(wire.subject.question,undefined);}
 assert.equal(readers[1].prompt,continuationPrompt('reader'));
});

test('RS4 missing or ambiguous selected question refuses before provider; current empty values and escaped addresses exist',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'mode'),'pause');
 const draft=f.engine.discovery.forStage('p','discovery','compilation'),q=f.store.get<Question>(draft.value.questions[0]!)!;
 const audit={store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'},role=f.environment.value.implementer;
 const question={id:q.id,...q.value.spec};
 for(const body of [{question:null},{questions:null},{questions:[]},{questions:[question,question]},{question:{...question,id:'foreign'}}])
  await assert.rejects(researchCall(role,f.environment.value,'Typed refusal',body,undefined,audit),{code:'context_question_invalid'});
 assert.equal(f.store.list('model-call').length,0);
 const body={role:'research',question,core:null,map:false,fields:0,inventory:[], 'a~/b':null};
 await researchCall(role,f.environment.value,'Preserve explicit empty values',body,undefined,audit);
 const second={...body,core:{changed:true},currentProposal:false};delete (second as any).inventory;
 const p=await previewResearch(()=>researchCall(role,f.environment.value,'Preserve explicit empty values',second,undefined,audit)),wire=JSON.parse(p.input);
 assertPacket(f.store,wire);const c=wire.subject.continuation;
 assert.ok(c.foundationPointers.includes('/body/inventory'));assert.ok(!c.foundationPointers.includes('/body/currentProposal'));
 assert.equal(resolveAddress(f.store,c.foundation,'/body/core'),null);
 assert.deepEqual(resolveAddress(f.store,c.current,'/body/core'),{changed:true});
 assert.equal(resolveAddress(f.store,c.current,'/body/a~0~1b'),null);
 assert.ok(wire.subject.working.sections.some((s:any)=>s.pointer==='/body/currentProposal'));
 assert.ok(!wire.subject.working.sections.some((s:any)=>s.pointer==='/body/inventory'));
 const foundation=f.store.get<any>(c.foundation.id)!;
 f.store.write({id:foundation.id,kind:'research-context',expected:foundation.revision,value:{...foundation.value,body:{core:'today'}}});
 const p2=JSON.parse((await previewResearch(()=>researchCall(role,f.environment.value,'Preserve explicit empty values',second,undefined,audit))).input);
 assert.deepEqual(p2.subject.continuation.foundationPointers,c.foundationPointers,'an exact old foundation never follows its head');
 assert.equal(canonical(resolveAddress(f.store,c.foundation,'/body/core')),'null');
});

test('RS4 full nonempty obligations and contracts survive foundation replacement, while insufficient capacity never sends',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'mode'),'pause');
 const spec:any={field:'result',kind:'design',prompt:'Keep every condition',risk:'Missing condition',proof:'assessment',
  schema:{type:'object',properties:{value:{type:'string',description:'Exact rule '.repeat(250)}},required:['value']},
  obligations:[{id:'o1',target:'target',field:'value',consumer:'compilation'}],targets:[{target:'target',field:'value',consumer:'compilation',question:'What value?'}],
  basisContract:'typed-v1',obligationContract:'evidence-v1',layerAssembly:{fixture:'Preserve the complete field without a new whitelist'}};
 const draft=f.engine.discovery.create('p','om-g2','R2','compilation',[spec]),q=f.store.get<Question>(draft.value.questions[0]!)!;
 const body={role:'research',questions:[{id:q.id,...spec}],core:spec.schema,map:spec.obligations};
 const audit={store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'},env=f.environment.value;
 await researchCall(env.implementer,env,'Exact role protocol',body,undefined,audit);
 const preview=await previewResearch(()=>researchCall(env.implementer,env,'Exact role protocol',body,undefined,audit));
 assertPacket(f.store,JSON.parse(preview.input));
 assert.deepEqual(JSON.parse(preview.input).subject.question.obligations,spec.obligations);
 const calls=f.store.list('model-call');
 await assert.rejects(researchCall(env.implementer,env,'Exact role protocol '+ 'x'.repeat(297000),body,undefined,audit),{code:'pilot_core_limit'});
 assert.deepEqual(f.store.list('model-call'),calls);
 await assert.rejects(researchCall(env.implementer,env,'Exact role protocol',{...body,questions:[{id:q.id,...spec,schema:{type:'string'}}]},undefined,audit),{code:'context_question_invalid'});
 assert.deepEqual(f.store.list('model-call'),calls);
});

test('RS4 native reading-planner and synthesis phases retain their own instructions across continuation',async t=>{
 const f=fixture(t);preparedFeatures(f.engine,'r');
 const {projectId:_projectId,...settings}=f.environment.value;
 const env=f.engine.environments.configure('r',settings,0);
 const r0=f.engine.refinement.begin('r','R0');f.engine.refinement.finishResearch('r','R0',reference(r0),0);f.engine.refinement.sealLayer('r',1,0);
 const draft=f.engine.refinement.begin('r','R1'),q=f.store.get<Question>(draft.value.questions[0]!)!;
 configureReaderPilot(f.store,f.engine.environments,'r',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'medium',speed:'inherited',command:f.command},agentCommand:f.command,maxCalls:30,maxReportedTokens:100000,maxRequestChars:100000,maxReadChars:60000,maxReplyChars:20000,planning:{fields:[q.value.spec.field],maxRequestChars:100000,maxRounds:5}},0);
 const log=join(f.root,'planner.jsonl');
 writeFileSync(f.path,`import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';
 const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,log=${JSON.stringify(log)};
 appendFileSync(log,JSON.stringify(r)+'\\n');let research;
 if(s.dispatchMode==='planning')research={action:'read_plan',question:s.question.id,reads:[{action:'read_context',record:${JSON.stringify(reference(f.store.get('graph-layer:r:1')!))},pointer:s.continuation.kind==='initial'?'/projection/title':'/projection/nodes/0/title'}]};
 else if(!existsSync(log+'.again')){writeFileSync(log+'.again','1');research={action:'need_research',question:s.question.id,missing:['A second explicit planning decision']};}
 else research={action:'pause',reason:'Stop after both real phases'};
 console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const run=await f.engine.researcher.run('r',draft.id,10);
 assert.equal(run.value.status,'paused',JSON.stringify(run.value));
 const wires=readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
 for(const wire of wires)assertPacket(f.store,wire);
 const planner=wires.filter(w=>w.subject.continuation.role==='reading-planner'),analyst=wires.filter(w=>w.subject.continuation.role==='analyst');
 assert.ok(planner.length>=2,JSON.stringify(run.value));assert.ok(analyst.length>=2,JSON.stringify({pauseCode:run.value.pauseCode,error:run.value.error,wires:wires.map(w=>({role:w.subject.continuation.role,kind:w.subject.continuation.kind,mode:w.subject.dispatchMode}))}));
 const session=f.store.list<any>('synthesis-session').find(item=>item.id.startsWith('synthesis-session:v2:'));
 assert.ok(session);
 const initial=f.store.get<any>(session.id,1)!;
 const reads=f.store.list<any>('research-turn').filter(turn=>(turn.value.action as {action?:string}).action==='read_context'
   && turn.value.question?.id===q.id && turn.value.number<initial.value.delivery.turn)
   .sort((a,b)=>a.value.number-b.value.number).map(turn=>turn.value.observation);
 assert.ok(reads.length>=1);
 assert.deepEqual(initial.value.workspace?.entries.map((entry:any)=>entry.result),reads);
 assert.deepEqual(readSynthesisSession(f.store,reference(session)),session);
 assert.ok(planner[0].prompt.includes('Choose what to read'));assert.ok(planner[1].prompt.includes(planner[0].prompt));
 assert.ok(analyst.every(w=>w.prompt.includes('substantive-answer phase')||w.prompt.includes('Build the final answer')));
 assert.equal(f.store.get('environment:r')!.hash,env.hash);
 const cold=new Store(join(f.root,'state.sqlite'));
 try {
  assert.deepEqual(readSynthesisSession(cold,reference(session)),session);
  const graph=cold.get<any>('graph:r')!,original=cold.get<any>('graph-layer:r:1')!;
  const changed=structuredClone(graph.value);changed.title+=' revised after paid synthesis';
  new ProductEngine(cold).execute({type:'save-graph',project:'r',graph:changed,expected:graph.revision});
  assert.notEqual(cold.get('graph-layer:r:1')!.hash,original.hash);
  assert.deepEqual(cold.get(original.id,original.revision),original);
  const heads=cold.list();
  assert.deepEqual(readSynthesisSession(cold,reference(session)),session);
  assert.deepEqual(cold.list(),heads);
 } finally {cold.close();}
});

test('RD2d planned context after reopen reaches C from the exact new question prefix',async t=>{
 const f=fixture(t);preparedFeatures(f.engine,'r');
 const {projectId:_projectId,...settings}=f.environment.value;
 f.engine.environments.configure('r',settings,0);
 const r0=f.engine.refinement.begin('r','R0');
 f.engine.refinement.finishResearch('r','R0',reference(r0),0);
 f.engine.refinement.sealLayer('r',1,0);
 const draft=f.engine.refinement.begin('r','R1'),q=f.store.get<Question>(draft.value.questions[0]!)!;
 configureReaderPilot(f.store,f.engine.environments,'r',{experimental:true,active:true,stopAfter:'L2',
  reader:{actor:'reader',model:'fixture',effort:'medium',speed:'inherited',command:f.command},
  agentCommand:f.command,maxCalls:30,maxReportedTokens:100000,maxRequestChars:100000,
  maxReadChars:60000,maxReplyChars:20000,
  planning:{fields:[q.value.spec.field],maxRequestChars:100000,maxRounds:5}},0);
 const log=join(f.root,'planner.jsonl');
 writeFileSync(f.path,`import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';
 const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject,log=${JSON.stringify(log)};
 appendFileSync(log,JSON.stringify(r)+'\\n');let research;
 if(s.dispatchMode==='planning')research={action:'read_plan',question:s.question.id,reads:[{action:'read_context',record:${JSON.stringify(reference(f.store.get('graph-layer:r:1')!))},pointer:s.continuation.kind==='initial'?'/projection/title':'/projection/nodes/0/title'}]};
 else if(!existsSync(log+'.again')){writeFileSync(log+'.again','1');research={action:'need_research',question:s.question.id,missing:['A second explicit planning decision']};}
 else research={action:'pause',reason:'Stop after the exact new prefix'};
 console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const first=await f.engine.researcher.run('r',draft.id,2);
 const oldTurns=f.store.list<any>('research-turn').filter(turn=>turn.value.run===first.id);
 assert.ok(oldTurns.some(turn=>turn.value.action.action==='read_context'&&turn.value.status==='completed'));
 assert.equal(f.store.list('synthesis-session').length,0);
 const oldCalls=f.store.list('model-call');assert.equal(oldCalls.length,1);
 const head=f.store.get<Question>(q.id)!;
 f.engine.execute({type:'reopen-question',question:head.id,expected:head.revision});
 const cold=new Store(join(f.root,'state.sqlite'));
 try {
  const resumed=await new ProductEngine(cold).researcher.run('r',draft.id,10);
  assert.notEqual(resumed.value.pauseCode,'research_context_undelivered',resumed.value.error??'');
  assert.notEqual(resumed.value.pauseCode,'synthesis_session_invalid',resumed.value.error??'');
  const reopened=cold.get<Question>(q.id)!;
  const currentReads=cold.list<any>('research-turn').filter(turn=>turn.value.run===first.id
   && turn.value.question?.revision===reopened.revision && turn.value.action.action==='read_context'
   && turn.value.status==='completed');
  assert.equal(currentReads.length,1);
  assert.equal(currentReads[0]!.value.observation.pointer,'/projection/nodes/0/title');
  const session=cold.list<any>('synthesis-session').find(item=>item.id.startsWith('synthesis-session:v2:')
   && canonical(item.value.binding.question)===canonical(reference(reopened))
   && item.value.workspace?.entries.length===1);
  assert.ok(session,'C must inherit the accepted new-revision lookup');
  assert.deepEqual(session.value.workspace.entries.map((entry:any)=>entry.result),
   currentReads.map(turn=>turn.value.observation));
  assert.deepEqual(readSynthesisSession(cold,reference(session)),session);
  const wires=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const delivered=wires.findLast(wire=>wire.subject.continuation.role==='analyst'
   && wire.subject.contextWorkspace?.length===1);
  assert.ok(delivered,'the new C packet must deliver the accepted lookup');
  assert.deepEqual(delivered.subject.contextWorkspace,currentReads.map(turn=>turn.value.observation));
  for(const old of oldCalls)assert.deepEqual(cold.get(old.id,old.revision),old);
  assert.equal(cold.list('model-call').length,oldCalls.length+3,'no old planned call is bought again');
  for(const old of oldTurns) {
   assert.deepEqual(cold.get(old.id,old.revision),old);
   assert.deepEqual(readResearchConsumerTurn(cold,reference(old)),old);
  }
 } finally {cold.close();}
});

test('RS4 exact Git 8b665772 producer: old completed and paid pending history and reader continuation survive restart unchanged',async t=>{
 const root=mkdtempSync(join(tmpdir(),'omg-rs4-era-')),era=join(root,'era'),archive=join(root,'archive.tar');mkdirSync(era);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('git',['archive','--format=tar',`--output=${archive}`,'8b665772db793b854d86ca557d359d8479a29c9c']);
 try{
  execFileSync('tar',['-xf',archive,'-C',era]);
 }finally{
  rmSync(archive,{force:true});
 }
 symlinkSync(resolve('node_modules'),join(era,'node_modules'));
 execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(era,'tsconfig.json')],{cwd:era,maxBuffer:4<<20});
 const script=join(era,'rs4-producer.mjs');
 writeFileSync(script,`import{readFileSync,writeFileSync}from'node:fs';
 import{Store}from'./dist/src/storage/store.js';import{ProductEngine}from'./dist/src/product/engine.js';import{reference}from'./dist/src/pipeline/contracts.js';
 import{configureReaderPilot}from'./dist/src/discovery/reader-pilot.js';import{readBundle}from'./dist/src/discovery/reader.js';import{EngineError}from'./dist/src/errors.js';
 const root=${JSON.stringify(root)},store=new Store(root+'/state.sqlite'),engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Old producer'});
 const source=engine.discovery.evidence.document('p','source','Exact saved original.','text/plain',0),adapter=root+'/adapter.mjs',wire=root+'/wires.jsonl';
 writeFileSync(adapter,\`import{readFileSync,appendFileSync,existsSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;appendFileSync(\${JSON.stringify(wire)},JSON.stringify(r)+'\\\\n');
 const file=\${JSON.stringify(root+'/turn')},n=existsSync(file)?+readFileSync(file,'utf8'):0;let research;
 if(s.role==='reader')research={selections:[{sourceIndex:0,firstLine:1,lastLine:1}],unresolved:[]};
 else{writeFileSync(file,String(n+1));research=n===0?{action:'read_source',source:\${JSON.stringify(reference(source))},start:0,end:21}:{action:'read_context',record:s.continuation.foundation,pointer:n===2?'/body/core':n===1?'/body/fields':'/body/fields/result'};}
 console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}}));\`);
 const command={executable:process.execPath,args:[adapter]},environment=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'medium',command},reviewer:{actor:'reviewer',model:'fixture',effort:'medium',command},fullCheck:command,timeoutMs:10000},0);
 const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'result',kind:'design',prompt:'Read the exact condition',risk:'Missing condition',schema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]),q=store.get(draft.value.questions[0]);
 const pilot=configureReaderPilot(store,engine.environments,'p',{experimental:true,active:true,stopAfter:'L2',reader:{actor:'reader',model:'fixture',effort:'medium',speed:'inherited',command},agentCommand:command,maxCalls:20,maxReportedTokens:100000,maxRequestChars:100000,maxReadChars:60000,maxReplyChars:20000},0);
 const readers=[];for(let i=0;i<2;i++){const s=engine.discovery.evidence.document('p','reader-'+i,'Exact reader '+i,'text/plain',0);readers.push(await readBundle(store,environment.value,pilot,reference(q),'Old reader '+i,[{source:reference(s),range:{start:0,end:s.value.content.length}}]));}
 for(let i=0;i<3;i++)await engine.researcher.run('p',draft.id,1);
 const write=store.writeMany.bind(store);let interrupted=false;store.writeMany=(writes,guards=[])=>{const result=write(writes,guards);if(!interrupted&&writes.some(w=>w.kind==='model-response')){interrupted=true;throw new EngineError('input_stale','Saved response before application');}return result;};
 await engine.researcher.run('p',draft.id,1);store.writeMany=write;
 const turns=store.list('research-turn').sort((a,b)=>a.value.number-b.value.number);
 const pending=store.list('research-consumer-intent').find(x=>x.value.kind==='analyst'&&x.value.state==='running');
 if(!interrupted||!pending||store.get(pending.value.call.id).value.status!=='succeeded')throw Error('Old producer did not retain the paid intent: '+JSON.stringify({interrupted,turns:turns.map(t=>({number:t.value.number,status:t.value.status,error:t.value.error})),pending}));
 writeFileSync(root+'/expected.json',JSON.stringify({draft,q,readers,turns,pending,records:store.list().filter(r=>['model-call','model-request','model-response','research-context'].includes(r.kind)),wires:readFileSync(wire,'utf8')}));store.close();`);
 execFileSync(process.execPath,[script],{cwd:era,maxBuffer:4<<20});
 const expected=JSON.parse(readFileSync(join(root,'expected.json'),'utf8'));
 const store=new Store(join(root,'state.sqlite'));t.after(()=>store.close());
 for(const reader of expected.readers)assert.deepEqual(readReaderResultAt(store,'p',reference(reader)),reader);
 for(const turn of expected.turns.filter((x:any)=>x.value.status==='completed'))assert.deepEqual(readResearchConsumerTurn(store,reference(turn)),turn);
 const engine=new ProductEngine(store);await engine.researcher.run('p',expected.draft.id,1);
 assert.equal(store.list<any>('research-turn').find(t=>t.value.number===expected.pending.value.cursor.turn)!.value.status,'completed');
 for(const old of expected.records)assert.deepEqual(store.get(old.id,old.revision),old);
 assert.deepEqual(store.list('model-call'),expected.records.filter((r:any)=>r.kind==='model-call'));
 assert.equal(readFileSync(join(root,'wires.jsonl'),'utf8'),expected.wires);
 const oldReader=expected.wires.trim().split('\n').map((x:string)=>JSON.parse(x)).filter((w:any)=>w.subject.continuation.role==='reader').at(-1);
 assert.equal(oldReader.prompt,continuationPrompt('reader'));
 const preview=await previewResearch(()=>engine.researcher.run('p',expected.draft.id,1));
 assertPacket(store,JSON.parse(preview.input));assert.equal(JSON.parse(preview.input).subject.continuation.previousCalls,4);
 const source=store.get<any>('source:p:source')!;
 writeFileSync(join(root,'adapter.mjs'),`import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8')),s=r.subject;
 if(!s.question.schema)throw Error('RS4 must deliver the actual schema');
 const research=s.continuation.role==='assessor'?{verdict:'supported',reasons:[]}:{action:'answer',question:s.question.id,value:{value:'A proposed design with an exact original'},citations:[{source:${JSON.stringify(reference(source))},selector:{kind:'text-range',start:0,end:${source.value.content.length}}}]};
 console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const accepted=await engine.researcher.run('p',expected.draft.id,1);
 assert.equal(accepted.value.status,'completed',JSON.stringify({code:accepted.value.pauseCode,error:accepted.value.error}));
 assert.equal(store.get<Question>(expected.q.id)!.value.status,'answered');
 for(const old of expected.records)assert.deepEqual(store.get(old.id,old.revision),old);

});

test('RS4 missing FieldSpec members and a competing question revision fail before a physical call',async t=>{
 const f=fixture(t),draft=f.engine.discovery.forStage('p','discovery','compilation');writeFileSync(join(f.root,'mode'),'pause');
 const initial=f.store.get<Question>(draft.value.questions[0]!)!,spec=initial.value.spec,env=f.environment.value;
 const audit={store:f.store,draftId:draft.id,questionId:initial.id,purpose:'analyst'};
 for(const missing of ['schema','field','kind','prompt','risk']) {
  const current=f.store.get<Question>(initial.id)!,broken:any={...spec};delete broken[missing];
  f.store.write({id:initial.id,kind:current.kind,expected:current.revision,value:{...current.value,spec:broken}});
  await assert.rejects(researchCall(env.implementer,env,'Must have the complete bound contract',{role:'research'},undefined,audit),
   (e:any)=>e.code==='context_question_invalid'&&e.message.includes(initial.id));
 }
 const old=f.store.get<Question>(initial.id)!;
 const restored=f.store.write<Question>({id:initial.id,kind:old.kind,expected:old.revision,value:{...initial.value,spec}});
 const another=new Store(join(f.root,'state.sqlite'));t.after(()=>another.close());
 await assert.rejects(researchCall(env.implementer,env,'Exact guarded contract',{role:'research',question:{id:initial.id,...spec}},undefined,
  {...audit,onContext:()=>{another.write({id:restored.id,kind:restored.kind,expected:restored.revision,value:restored.value});}}),{code:'input_stale'});
 assert.equal(f.store.list('model-call').length,0);assert.equal(f.wires().length,0);
});


test('RS4 substituted foundation or missing bound references refuse before a physical continuation',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'mode'),'pause');
 const draft=f.engine.discovery.forStage('p','discovery','compilation'),q=f.store.get<Question>(draft.value.questions[0]!)!;
 const audit={store:f.store,draftId:draft.id,questionId:q.id,purpose:'analyst'},role=f.environment.value.implementer;
 const body={question:{id:q.id,...q.value.spec},core:{title:'Exact foundation'}};
 await researchCall(role,f.environment.value,'Bound foundation',body,undefined,audit);
 const call=f.store.list<any>('model-call')[0]!,original=f.store.get<any>(call.value.packet.archive.id)!;
 const changes=[{...original.value,projectId:'foreign'},{...original.value,question:null},
  {...original.value,question:{...original.value.question,id:'question:foreign'}},
  {...original.value,draft:null},{...original.value,draft:{...original.value.draft,id:'draft:foreign'}}];
 for(const [i,value] of changes.entries()) {
  const forged=f.store.write({id:'research-context:forged-'+i,kind:'research-context',expected:0,value});
  const current=f.store.get<any>(call.id)!;
  f.store.write({id:call.id,kind:'model-call',expected:current.revision,value:{...call.value,packet:{...call.value.packet,archive:reference(forged)}}});
  await assert.rejects(previewResearch(()=>researchCall(role,f.environment.value,'Bound foundation',body,undefined,audit)),{code:'continuation_foreign'});
 }
 const current=f.store.get<any>(call.id)!;
 f.store.write({id:call.id,kind:'model-call',expected:current.revision,value:{...call.value,packet:{...call.value.packet,archive:{...reference(original),hash:'0'.repeat(64)}}}});
 await assert.rejects(previewResearch(()=>researchCall(role,f.environment.value,'Bound foundation',body,undefined,audit)),{code:'continuation_foreign'});
 assert.equal(f.store.list('model-call').length,1);assert.equal(f.wires().length,1);
});


test('RS4 exact archive indexes retain sizes and counts, and empty protocol arrays do not claim delivery',t=>{
 const f=fixture(t),draft=f.engine.discovery.forStage('p','discovery','compilation'),q=f.store.get<Question>(draft.value.questions[0]!)!;
 const readings=Array.from({length:3},(_,i)=>({observations:[{value:'condition-'+i+'x'.repeat(50000)}]}));
 const body={question:{id:q.id,...q.value.spec},core:{objective:'Exact index'},readings,focus:readings.at(-1)};
 const packet=workingContext(f.store,'p',draft.id,q.id,body,40000);
 assert.ok(JSON.stringify(packet).length<=40000);assert.deepEqual(packet.readings,[]);
 assert.ok(packet.working.omitted.includes('readings'));
 const section=packet.working.sections.find((s:any)=>s.pointer==='/body/readings');
 assert.equal(section.count,3);assert.equal(section.chars,JSON.stringify(readings).length);
 assert.deepEqual(resolveAddress(f.store,packet.working.archive,section.pointer),readings);
});


test('DS1-01 Discovery v6 keeps the researched plan and prior v4/v5 contracts', t => {
 const f=fixture(t),draft=f.engine.prepare('p','discovery');
 assert.equal(draft.value.contractVersion,6);assert.equal(RESEARCH_CONTRACT_VERSION,6);
 assert.deepEqual(draft.value.questions.map(id=>f.store.get<Question>(id)!.value.spec.field),
  ['brief','objective','researchPlan','researchReport','verdict','preparation']);
 assert.deepEqual(VERSION4_REQUIREMENTS.discovery.map(q=>q.field),['brief','objective','preparation']);
 const currentPreparation=REQUIREMENTS.discovery.at(-1)!,priorPreparation=VERSION4_REQUIREMENTS.discovery.at(-1)!;
 assert.deepEqual({...currentPreparation,prompt:priorPreparation.prompt},priorPreparation);
 assert.ok(currentPreparation.prompt.startsWith(priorPreparation.prompt));
 assert.match(currentPreparation.prompt,/discoveryContext.reportConstraints/);
 assert.deepEqual(VERSION6_REQUIREMENTS.discovery,VERSION5_REQUIREMENTS.discovery);
 assert.deepEqual(REQUIREMENTS.discovery.map(spec=>Object.hasOwn(DISCOVERY_ANALOGUES_PROMPTS,spec.field)
  ? {...spec,prompt:VERSION6_REQUIREMENTS.discovery.find(old=>old.field===spec.field)!.prompt}:spec),VERSION6_REQUIREMENTS.discovery);
 assert.deepEqual(REQUIREMENTS.discovery.filter((spec,index)=>spec.prompt!==VERSION6_REQUIREMENTS.discovery[index]!.prompt).map(spec=>spec.field),
  ['researchPlan','researchReport','verdict']);
 for(const [field,prompt] of Object.entries(DISCOVERY_ANALOGUES_PROMPTS))
  assert.equal(REQUIREMENTS.discovery.find(spec=>spec.field===field)!.prompt,prompt);
 for(const stage of UPSTREAM_STAGES.filter(stage=>stage==='operation-map'||stage==='features'))
  assert.deepEqual(REQUIREMENTS[stage],VERSION4_REQUIREMENTS[stage]);
 for(const stage of ['concept','specification'] as const) {
  const detail=REQUIREMENTS[stage].at(-1)!;
  assert.match(detail.prompt,/applications/);
  assert.equal(new Ajv({strict:true}).compile(detail.schema as object)(preparedField('p',detail.field)),false);
 }
 const spec=REQUIREMENTS.discovery.find(q=>q.field==='researchPlan')!,validate=new Ajv({strict:true}).compile(spec.schema as object);
 assert.equal(spec.kind,'design');assert.equal(spec.proof,'assessment');
 const plans=[
  ['Subscription and API harness','Integration architect','Provider authentication documentation','Which supported interfaces separate subscription access from API credentials?'],
  ['Lighting fixture bus','Electrical systems engineer','Electrical standards and bus specifications','Which supply and control constraints determine safe interoperability?'],
  ['Levitating nightstand','Control and mechanical engineer','Actuation and stability experiments','Can the object remain stable within the stated energy, load and safety constraints?'],
 ].map(([domain,role,source,question])=>({domain,roles:[{role,side:domain,why:'This perspective addresses the feasibility risk'}],
  startingQuestions:[{id:'start',question,why:'Choose an evidence-backed direction'}],sources:[{id:'primary',kind:'documentation or experiment',what:source,why:'Resolve the material uncertainty'}],
  feasibilityQuestions:[{id:'feasible',question,why:'Do not promise an unsupported result'}],deliverable:'A sourced report and a justified feasibility verdict'}));
 for(const plan of plans){assert.equal(validate(plan),true,JSON.stringify(validate.errors));assert.equal(validate({...plan,sources:[]}),false);}
 assert.equal(new Set(plans.map(plan=>plan.roles[0]!.role)).size,3);
 const verdict=REQUIREMENTS.discovery.find(q=>q.field==='verdict')!;
 const check=new Ajv({strict:true}).compile(verdict.schema as object);
 assert.equal(check({researchReport:{id:'answer',revision:1,hash:'a'.repeat(64)},outcome:'conditional',reason:'Evidence is missing',variant:'Bounded experiment',
  bases:[{result:'missing',reason:'No measurement'}],conditions:[{id:'measure',kind:'evidence',condition:'Demonstrate stability',criterion:'Observed stability within the agreed envelope',fulfilled:true}]}),false);
});

test('DS1-08 packed initial and continuation deliver exact accepted grounds to analyst and assessor; oversized grounds are addressed',async t=>{
 const f=fixture(t);preparedFeatures(f.engine,'complete');
 const stage=f.store.get<any>('stage:complete:discovery')!,draft=f.store.get<DiscoveryDraft>(stage.value.content.draft.id)!;
 writeFileSync(join(f.root,'mode'),'pause');
 const command={executable:process.execPath,args:[f.path]},settings={workspace:f.root,implementer:{actor:'author',model:'fixture',effort:'medium' as const,command},reviewer:{actor:'assessor',model:'fixture',effort:'medium' as const,command},fullCheck:command,timeoutMs:10000};
 const env=f.engine.environments.configure('complete',settings,0);
 for(const field of ['researchReport','verdict','preparation'])for(const purpose of ['analyst','assessor']) {
  const q=f.store.get<Question>(draft.value.questions.find(id=>f.store.get<Question>(id)!.value.spec.field===field)!)!;
  const context=discoveryContext(f.store,draft,q).context!;
  const body={role:purpose==='analyst'?'research':'assess-answer',question:{id:q.id,...q.value.spec},discoveryContext:context,
    core:context.fields.researchPlan?.value,observations:[],value:draft.value.fields[field]};
  const audit={store:f.store,draftId:draft.id,questionId:q.id,purpose},role=purpose==='analyst'?env.value.implementer:env.value.reviewer;
  const before=f.store.list('model-call').length;
  const initial=JSON.parse((await previewResearch(()=>researchCall(role,env.value,'Preserve this role and its material',body,undefined,audit))).input);
  assert.deepEqual(initial.subject.discoveryContext,context);assert.equal(initial.subject.continuation.kind,'initial');
  await researchCall(role,env.value,'Preserve this role and its material',body,undefined,audit);
  const next=JSON.parse((await previewResearch(()=>researchCall(role,env.value,'Preserve this role and its material',body,undefined,audit))).input);
  assert.deepEqual(next.subject.discoveryContext,context);assert.equal(next.subject.continuation.kind,'continuation');
  assert.ok(next.prompt.includes('Preserve this role and its material'));
  const oversized=structuredClone(body);(oversized.discoveryContext.fields.researchPlan!.value as any).deliverable='x'.repeat(350000);
  let sent:any;
  await researchCall(role,env.value,'Preserve this role and its material',oversized,undefined,
    {...audit,onContext:packet=>{sent=packet;}});
  const delivery=sent.materialDelivery?.[0];
  assert.equal(delivery?.contract,'research-delivery/v1');
  assert.equal(delivery.original.pointer,'/body/discoveryContext');
  const archived=f.store.get<any>(delivery.original.record.id,delivery.original.record.revision)!;
  assert.deepEqual(contextValue(archived.value,delivery.original.pointer),oversized.discoveryContext);
  assert.equal(delivery.original.valueHash,hashJson(oversized.discoveryContext));
  assert.equal(delivery.text,canonical(oversized.discoveryContext).slice(delivery.served.offset,delivery.served.end));
  assert.ok(delivery.served.end>0&&delivery.served.next===delivery.served.end&&delivery.served.end<delivery.served.total);
  assert.ok(!Object.hasOwn(sent,'discoveryContext')&&JSON.stringify(sent).length<=300000);
  assert.equal(f.store.list('model-call').length,before+2);
 }
});


for(const outcome of ['go','insufficient_evidence'] as const)
test(`DS2 new plan/report/verdict reach A and B; absent analogues alone allow go (${outcome})`,async t=>{
 const f=fixture(t,false,values=>{
  const plan=values['researchPlan'] as any;
  plan.startingQuestions.push({id:'analogues',question:'Какие полезные решения уже есть в предоставленных материалах?',why:'Использовать или адаптировать подходящее'});
  plan.sources.push({id:'local-projects',kind:'provided local documents',what:'Проверить только предоставленный локальный проект; внешний поиск не выполнен',why:'Найти пригодные решения в доступных материалах'});
  values['feasibilityEvidence']={technology:'Native JavaScript string transformation',component:'Node.js local file input/output',
   compatibility:outcome==='go'?'UTF-8 input and output share the same representation':null,
   assembly:'Read local UTF-8 text, transform its string, validate and write local UTF-8 output'};
  const report=values['researchReport'] as any;
  report.results[0].conclusion=outcome==='go'?'Native JavaScript string transformation and Node.js local file input/output use compatible UTF-8 representations; read, transform, validate and write gives a bounded assembly path.':
   'Native JavaScript string transformation and Node.js local file input/output are available; the required component compatibility has not been established.';
  report.openQuestions.push({id:'unknown-analogues',question:'analogues',reason:'аналогов не найдено в предоставленных материалах. Внешний поиск не выполнен; это не утверждение об отсутствии аналогов вообще.'});
  const verdict=values['verdict'] as any;
  verdict.outcome=outcome;
  verdict.reason=outcome==='go'?'Локальная функция обоснована предоставленным описанием преобразования, совместимости входа/выхода и пути сборки. Наличие аналогов не требуется.':
   'Независимый пробел: совместимость необходимого компонента ещё не установлена.';
  if(outcome!=='go')report.openQuestions.push({id:'missing-component',question:'feasibility',reason:'Нет данных о совместимости необходимого компонента; это независимый вопрос реализуемости.'});
 });
 const draft=f.engine.prepare('p','discovery');
 for(const id of draft.value.questions){const q=f.store.get<Question>(id)!;
  if(q.value.spec.kind==='fact')f.engine.discovery.fact(id,q.revision,reference(f.source),{kind:'json-pointer',pointer:'/'+q.value.spec.field});
  if(q.value.spec.kind==='decision')f.engine.discovery.decision(id,q.revision,'owner',f.values[q.value.spec.field]!);
 }
 const result:any=await f.engine.execute({type:'research-stage',project:'p',draftId:draft.id,maxTurns:30});
 assert.equal(result.discovery?.state,outcome,JSON.stringify({result,providerErrors:f.store.list<any>('model-response').map(row=>row.value.assessmentExecution?.process.stderr??row.value.consumerExecution?.process.stderr).filter(Boolean)}));
 assert.equal(result.status==='accepted',outcome==='go');
 const wires=f.wires();
 for(const [field,prompt] of Object.entries(DISCOVERY_ANALOGUES_PROMPTS)) {
  const question=f.store.get<Question>(draft.value.questions.find(id=>f.store.get<Question>(id)!.value.spec.field===field)!)!;
  const packets=wires.filter(w=>w.subject.continuation.question===question.id);
  assert.deepEqual([...new Set(packets.map(w=>w.subject.continuation.role))].sort(),['analyst','assessor']);
  for(const packet of packets){assertPacket(f.store,packet);assert.equal(packet.subject.question.prompt,prompt);}
 }
 const prompt=DISCOVERY_ANALOGUES_PROMPTS.researchPlan;
 for(const phrase of ['для программы','для сайта','для исследования','для услуги или продукта','для мероприятия',
  'определи свои места поиска','текущего и прошлого года','не обязательный список','не выдавай запланированный поиск за выполненный'])assert.ok(prompt.includes(phrase),phrase);
 assert.match(prompt,/интернете сам по себе не является целью или обязательным действием/);
 assert.match(DISCOVERY_ANALOGUES_PROMPTS.researchReport,/отдельно — основания реализуемости/);
 assert.match(DISCOVERY_ANALOGUES_PROMPTS.verdict,/не поддерживай отказ, единственной причиной которого является отсутствие аналога/);
 const current=f.store.get<DiscoveryDraft>(draft.id)!;
 const report=current.value.fields['researchReport'] as any,verdict=current.value.fields['verdict'] as any;
 assert.equal(report.openQuestions[0].question,'analogues');assert.ok(report.results.every((row:any)=>row.citations.length>0));
 assert.equal(verdict.outcome,outcome);assert.deepEqual(verdict.conditions,[]);
 const plan=current.value.fields['researchPlan'] as any;
 assert.ok(plan.sources.length>0);assert.equal('analogues' in plan,false);assert.equal('url' in plan.sources.at(-1),false);
 const paid=f.store.list('model-call').length,second=new Store(join(f.root,'state.sqlite'));
 try {
  const historical=second.get<DiscoveryDraft>(draft.id)!;
  assert.deepEqual(historical,current);assert.equal(discoveryOutcome(second,historical).state,outcome);
  assert.equal(second.list('model-call').length,paid);assert.equal(f.wires().length,wires.length);
 } finally {second.close();}
});
