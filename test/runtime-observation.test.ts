import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync,mkdirSync,chmodSync} from 'node:fs';
import {join,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference} from '../src/pipeline/contracts.js';
import {digest,hashJson,type Json} from '../src/canonical.js';
import {configureResearchScope,scopedQuestions} from '../src/graph/research-scope.js';
import {withTypedBasis} from '../src/graph/research-basis.js';
import {withObligationEvidence} from '../src/graph/obligation-evidence.js';
import {technicalProposalFindings} from '../src/graph/research-evidence.js';
import {collectRuntimeEvidence} from '../src/graph/runtime-evidence.js';
import {assessAnswer} from '../src/discovery/research-assessment.js';
import {researchCall} from '../src/discovery/research-protocol.js';
import {configureReaderPilot} from '../src/discovery/reader-pilot.js';
import {processStart} from '../src/runtime/process-identity.js';
import type {RuntimeObservationResult} from '../src/runtime/runtime-observation.js';
import type {RuntimeObservation} from '../src/runtime/runtime-observation-model.js';
import type {RuntimeCheck} from '../src/graph/obligation-policy.js';
import type {Source} from '../src/evidence/evidence.js';
import type {Question} from '../src/discovery/discovery.js';
import type {Graph} from '../src/graph/model.js';
import type {TechnicalReport} from '../src/graph/research-contracts.js';
import type {ResearchAction,ResearchAssessment} from '../src/discovery/research-model.js';

async function until(predicate:()=>boolean){const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw Error('Fixture did not reach expected state');await new Promise(r=>setTimeout(r,10));}}
function fixture(t:test.TestContext,mode='positive',delay=60,timeoutMs=4000){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'omg-runtime-observation-'))),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Runtime observation fixture'});
 const graph={nodes:[{id:'n',code:[]}],horizon:[],connectors:[],tests:[],anchors:[]} as unknown as Graph;
 store.write({id:'graph:p',kind:'graph',expected:0,value:graph});
 const layer=store.write({id:'graph-layer:p:2',kind:'graph-layer',expected:0,value:{projection:graph}});
 const gap={id:'boundary',target:'n',field:'code',consumer:'compilation',requiredFor:'next' as const,question:'Record what the fixture actually did; this is not a real sandbox capability claim'};
 const r1=store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:'p',fields:{technical:{gaps:[gap]}}}});
 const phase=store.write({id:'phase:p:R1',kind:'phase',expected:0,value:{draft:reference(r1)}});
 const original=configureResearchScope(store,{projectId:'p',layer:reference(layer),r1:reference(phase),outcome:'Trace actual fixture behavior',nodes:['n'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
  obligations:[{gap,state:'active',reason:'Original fixture requirement',wake:null}]},0);
 const marker=join(root,'invocations.log'),subject=join(root,'runtime-subject.bin'),helper=join(root,'helper.mjs');
 writeFileSync(subject,'release-one');writeFileSync(helper,"export const tag='pinned-original';\n");
 writeFileSync(join(root,'check.mjs'),`import{readFileSync,appendFileSync,existsSync}from'node:fs';import{tag}from'./helper.mjs';const input=JSON.parse(readFileSync(0,'utf8'));appendFileSync(process.argv[2],'executed\\n');const finish=()=>{console.log(JSON.stringify({fixture:true,tag,root:input.runtime.root,mode:process.argv[3]}));if(process.argv[3]==='negative')process.exitCode=7;};if(process.argv[3]==='wait'){const timer=setInterval(()=>{if(existsSync(process.argv[2]+'.release')){clearInterval(timer);finish();}},10);}else setTimeout(finish,Number(process.argv[4]));`);
 const code=engine.discovery.evidence.file('p','check',root,'check.mjs','text/plain',0),dependency=engine.discovery.evidence.file('p','helper',root,'helper.mjs','text/plain',0);
 const check:RuntimeCheck={script:reference(code),dependencies:[reference(dependency)],subjects:['runtime-subject.bin'],executables:[],args:[marker,mode,String(delay)],timeoutMs,purpose:'Capture the executed fixture, never claim a production sandbox test'};
 const scope=configureResearchScope(store,{...original.value,policy:{version:1,sourceScope:reference(original),assignments:[{obligation:gap.id,original:{record:reference(original),pointer:'/obligations/0/gap'},
  kind:'environment-confirmation',moment:'R2',responsibleNode:'n',responsibleConsumer:'compilation',neededForR2:true,reason:'Need an actual invocation result',returnCondition:null,runtimeCheck:check}]}},1);
 const wire=join(root,'assessor-wire.json'),adapter=join(root,'assessor.mjs');
 writeFileSync(adapter,`import{readFileSync,writeFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));writeFileSync(${JSON.stringify(wire)},JSON.stringify(r));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:r.subject.role==='assess-answer'?{verdict:'supported',reasons:[]}:JSON.parse(readFileSync(${JSON.stringify(join(root,'answer.json'))},'utf8')),usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
 const command={executable:process.execPath,args:[adapter]};
 const environment=engine.environments.configure('p',{workspace:root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'assessor',model:'fixture',effort:'high',command},fullCheck:{executable:process.execPath,args:['--version']},timeoutMs:5000},0);
 const spec=withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(s=>s.obligations)!));
 const draft=engine.discovery.create('p','om-g2','R2','compilation',[spec],[reference(scope)],2),question=store.get<Question>(draft.value.questions[0]!)!;
 const observe=(key='one')=>engine.execute({type:'observe-runtime',project:'p',scope:reference(scope),obligation:'boundary',key}) as Promise<RuntimeObservationResult>;
 const proposal=(source:ReturnType<Store['get']>)=>{
  assert.ok(source);const observation=engine.discovery.evidence.observe('p',reference(source),{kind:'json-pointer',pointer:'/result/stdout'});
  const report:TechnicalReport={applicability:'applicable',reason:'An actual fixture invocation was observed',facts:[],designs:[{id:'d',decision:'Use only the recorded fixture result',benefit:'No invented runtime behavior',consumer:'compilation'}],gaps:[],
   documents:[{id:'runtime',kind:'document-observation',citation:0,quote:String(observation.value).trim(),claim:'The fixture emitted the quoted output; this does not certify all runtime capabilities',designs:['d'],gaps:[]}],coverage:[{obligation:'boundary',facts:[],designs:['d'],gaps:[]}]};
  const action:Extract<ResearchAction,{action:'answer'}>={action:'answer',question:question.id,value:report as unknown as Json,citations:[{source:observation.source,selector:observation.selector}]};
  return {observation,report,action};
 };
 return{root,store,engine,graph,original,scope,code,dependency,check,environment,spec,draft,question,marker,subject,helper,wire,observe,proposal};
}

test('owner-declared check runs from pinned code, publishes exact provenance and replays without another invocation',async t=>{
 const f=fixture(t),result=await f.observe();
 assert.equal(result.observation.value.status,'observed');assert.equal(result.observation.value.result!.exitCode,0);assert.ok(result.source);
 assert.deepEqual(result.source.value.provenance,{kind:'runtime-observation',record:reference(result.observation)});
 assert.equal(result.observation.value.check.script.hash,f.code.hash);
 assert.notEqual(result.observation.value.invocation!.args[0],f.code.value.origin.location);
 assert.equal(existsSync(result.observation.value.snapshot!),false);
 assert.deepEqual(await f.observe(),result);assert.equal(readFileSync(f.marker,'utf8'),'executed\n');
 assert.equal(f.store.list('model-call').length,0);assert.equal(f.store.list('research-budget').length,0);
 assert.equal(f.store.get<any>(`project-dispatch:${hashJson('p')}`)!.value.serial,1);
});

test('a nonzero completion is preserved as an observation, not converted to a successful check',async t=>{
 const f=fixture(t,'negative'),result=await f.observe();
 assert.equal(result.observation.value.status,'observed');assert.equal(result.observation.value.result!.exitCode,7);assert.ok(result.source);
 const content=JSON.parse(result.source.value.content);assert.equal(content.result.exitCode,7);assert.match(content.proofLimit,/requires assessment|require assessment/);
 const p=f.proposal(result.source);
 assert.deepEqual(technicalProposalFindings(f.store,'p','R2',f.question.id,f.spec.field,p.report,[p.observation],f.graph,f.root),[]);
});

test('real provenance closes the evidence-type check and the assessor receives full output and checker sources',async t=>{
 const f=fixture(t),result=await f.observe(),p=f.proposal(result.source);
 const collected=collectRuntimeEvidence(f.store,'p',f.spec,p.report,[p.observation]);
 assert.equal(collected.proofs.length,1);assert.equal(collected.supporting.length,3);
 const assessment=await assessAnswer(f.store,f.question,p.action,f.environment,f.root);
 assert.equal(assessment.value.observations.length,1,'Citation indices stay attached to the original citations');
 assert.equal(assessment.value.runtimeProofs!.length,1);
 const sent=JSON.parse(readFileSync(f.wire,'utf8'));
 assert.equal(sent.subject.runtimeProofs.length,1);
 assert.ok(sent.subject.observations.some((o:any)=>o.source.id===f.code.id));
 assert.ok(sent.subject.observations.some((o:any)=>o.source.id===f.dependency.id));
 assert.ok(sent.subject.observations.some((o:any)=>o.source.id===result.source!.id&&o.selector.kind==='json-pointer'&&o.selector.pointer===''));
 const lost=f.store.write<ResearchAssessment>({id:'lost-runtime-proof',kind:'research-assessment',expected:0,value:{...assessment.value,runtimeProofs:[]}});
 assert.throws(()=>f.engine.discovery.researched(f.question.id,f.question.revision,reference(lost)),{code:'research_runtime_evidence_invalid'});
 f.engine.discovery.researched(f.question.id,f.question.revision,reference(assessment));
 const gate=f.engine.discovery.gate('p',reference(f.store.get(f.draft.id)!));assert.deepEqual(gate.findings,[]);
 assert.ok(gate.guards.some(ref=>ref.id===f.dependency.id));assert.ok(gate.guards.some(ref=>ref.id===result.observation.id));
});

test('the public researcher consumes a ready runtime source without asking the owner to invent a fact',async t=>{
 const f=fixture(t),observed=await f.observe(),proposal=f.proposal(observed.source);
 writeFileSync(join(f.root,'answer.json'),JSON.stringify(proposal.action));
 const run=await f.engine.researcher.run('p',f.draft.id,5);
 assert.equal(run.value.status,'completed');assert.equal(run.value.ownerQuestion,null);
 assert.equal(f.store.get<Question>(f.question.id)!.value.status,'answered');
 assert.equal(f.store.list('model-call').length,2,'Only analyst and assessor use models; the local observation does not');
});

test('an explicit operator module executes without adding files to the accepted repository snapshot',async t=>{
 const f=fixture(t),code=f.engine.discovery.evidence.document('p','operator-module',"setTimeout(()=>console.log('operator-module-observed'),50);",'text/plain',0);
 const check:RuntimeCheck={script:reference(code),dependencies:[],subjects:[],executables:[],args:[],timeoutMs:4000,purpose:'Execute explicitly supplied operator code; not a repository implementation claim'};
 const scope=configureResearchScope(f.store,{...f.scope.value,policy:{...f.scope.value.policy!,assignments:f.scope.value.policy!.assignments.map(a=>({...a,runtimeCheck:check}))}},f.scope.revision);
 const observed=await f.engine.execute({type:'observe-runtime',project:'p',scope:reference(scope),obligation:'boundary',key:'operator'}) as RuntimeObservationResult;
 assert.equal(observed.observation.value.status,'observed');assert.equal(observed.observation.value.codeRoot,null);
 assert.match(observed.observation.value.result!.stdout,/operator-module-observed/);
 assert.equal(existsSync(join(f.root,'operator-module.mjs')),false);
 const spec=withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(s=>s.obligations)!));
 const p=f.proposal(observed.source);
 assert.equal(collectRuntimeEvidence(f.store,'p',spec,p.report,[p.observation]).proofs.length,1);
 assert.deepEqual(f.store.get(f.original.id,f.original.revision),f.original);
});

test('copied text, altered source data and an owner-intent label cannot masquerade as an executed result',async t=>{
 const f=fixture(t),result=await f.observe();assert.ok(result.source);
 const copy=f.engine.discovery.evidence.document('p','copied-runtime-json',result.source.value.content,'application/json',0),copied=f.proposal(copy);
 assert.ok(technicalProposalFindings(f.store,'p','R2',f.question.id,f.spec.field,copied.report,[copied.observation],f.graph,f.root).some(x=>x.code==='environment_confirmation_required'));
 const p=f.proposal(result.source),intent={...p.report,documents:p.report.documents!.map(d=>({...d,kind:'owner-document' as const}))};
 assert.ok(technicalProposalFindings(f.store,'p','R2',f.question.id,f.spec.field,intent,[p.observation],f.graph,f.root).some(x=>x.code==='document_evidence_required'));
 const raw=JSON.parse(result.source.value.content);raw.result.stdout='invented observation';const content=JSON.stringify(raw);
 const changed=f.store.write<Source>({id:result.source.id,kind:'source',expected:result.source.revision,value:{...result.source.value,content,sha256:digest(content)}});
 const forged=f.proposal(changed);
 assert.ok(technicalProposalFindings(f.store,'p','R2',f.question.id,f.spec.field,forged.report,[forged.observation],f.graph,f.root).some(x=>x.code==='environment_confirmation_required'));
 await assert.rejects(f.observe(),{code:'runtime_observation_source_changed'});
});

test('constant-path runtime subject replacement and changed environment invalidate current confirmation',async t=>{
 const f=fixture(t),result=await f.observe(),p=f.proposal(result.source);
 writeFileSync(f.subject,'release-two');
 assert.equal(collectRuntimeEvidence(f.store,'p',f.spec,p.report,[p.observation]).proofs.length,0);
 const other=fixture(t),observed=await other.observe(),q=other.proposal(observed.source);
 const {projectId,...settings}=other.environment.value;
 other.engine.environments.configure('p',{...settings,implementer:{...settings.implementer,model:'different-runtime'}},other.environment.revision);
 assert.equal(collectRuntimeEvidence(other.store,'p',other.spec,q.report,[q.observation]).proofs.length,0);
});

test('context-size changes alone do not invalidate a runtime observation',async t=>{
 const f=fixture(t),command={executable:process.execPath,args:['--version']};
 const settings={experimental:true as const,active:true,stopAfter:'L2' as const,reader:{actor:'reader',model:'fixture',effort:'high' as const,speed:'inherited' as const,command},agentCommand:command,maxRequestChars:300000,maxContinuationChars:100000,maxReadChars:60000,maxReplyChars:100000,maxCalls:100,maxReportedTokens:20000000};
 const pilot=configureReaderPilot(f.store,f.engine.environments,'p',settings,0);
 const result=await f.observe(),p=f.proposal(result.source);
 configureReaderPilot(f.store,f.engine.environments,'p',{...settings,maxContinuationChars:120000,contextLimits:{maxLookups:3,maxChars:60000}},pilot.revision);
 assert.equal(collectRuntimeEvidence(f.store,'p',f.spec,p.report,[p.observation]).proofs.length,1);
});

test('executable subjects follow the target workspace PATH and detect a different resolved binary',async t=>{
 const f=fixture(t),previous=process.env['PATH'];
 t.after(()=>{if(previous===undefined)delete process.env['PATH'];else process.env['PATH']=previous;});
 const first=join(f.root,'bin-one'),second=join(f.root,'bin-two'),empty=join(f.root,'empty');
 for(const dir of [first,second,empty])mkdirSync(dir);
 for(const [dir,label] of [[first,'one'],[second,'two']]){const path=join(dir!,'omg-runtime-fixture-tool');writeFileSync(path,`#!/bin/sh\nprintf '${label}\\n'\n`);chmodSync(path,0o755);}
 process.env['PATH']=['bin-one',previous??''].join(delimiter);
 const policy={...f.scope.value.policy!,assignments:f.scope.value.policy!.assignments.map(a=>({...a,runtimeCheck:{...a.runtimeCheck!,executables:['omg-runtime-fixture-tool']}}))};
 const scope=configureResearchScope(f.store,{...f.scope.value,policy},f.scope.revision);
 const result=await f.engine.execute({type:'observe-runtime',project:'p',scope:reference(scope),obligation:'boundary',key:'path'}) as RuntimeObservationResult;
 assert.equal(result.observation.value.status,'observed');assert.equal(result.observation.value.subjects.find(s=>s.kind==='executable')!.path,join(first,'omg-runtime-fixture-tool'));
 const p=f.proposal(result.source),spec=withObligationEvidence(withTypedBasis(scopedQuestions(scope.value).find(s=>s.obligations)!));
 process.env['PATH']=[empty,first,previous??''].join(delimiter);
 assert.equal(collectRuntimeEvidence(f.store,'p',spec,p.report,[p.observation]).proofs.length,1,'An irrelevant prefix must not invalidate the same resolved runtime');
 process.env['PATH']=[second,first,previous??''].join(delimiter);
 assert.equal(collectRuntimeEvidence(f.store,'p',spec,p.report,[p.observation]).proofs.length,0,'The old binary still exists, but the actual resolver now selects another');
});

test('effective process identity and HOME changes invalidate runtime confirmation without changing the project label',async t=>{
 const f=fixture(t),result=await f.observe(),p=f.proposal(result.source);
 if(process.geteuid){
  const host=process as NodeJS.Process & {geteuid:()=>number},uid=host.geteuid();
  const mock=t.mock.method(host,'geteuid',()=>uid+1);
  assert.equal(collectRuntimeEvidence(f.store,'p',f.spec,p.report,[p.observation]).proofs.length,0);
  mock.mock.restore();
 }
 assert.equal(collectRuntimeEvidence(f.store,'p',f.spec,p.report,[p.observation]).proofs.length,1);
 const previous=process.env['HOME'];t.after(()=>{if(previous===undefined)delete process.env['HOME'];else process.env['HOME']=previous;});
 process.env['HOME']=f.root;
 assert.equal(collectRuntimeEvidence(f.store,'p',f.spec,p.report,[p.observation]).proofs.length,0);
});

test('active observation blocks policy changes, concurrent keys and recovery of its live owner',async t=>{
 const f=fixture(t,'wait',0,10000),pending=f.observe();
 await until(()=>Boolean(f.store.list<RuntimeObservation>('runtime-observation')[0]?.value.child));
 const active=f.store.list<RuntimeObservation>('runtime-observation')[0]!;
 let completed:RuntimeObservationResult;
 try{
 const duplicate=await f.observe();assert.equal(duplicate.observation.value.status,'running');assert.equal(duplicate.source,null);
 await assert.rejects(f.observe('other'),{code:'runtime_observation_busy'});
 const policy={...f.scope.value.policy!,assignments:f.scope.value.policy!.assignments.map(a=>({...a,reason:'Changed declaration'}))};
 assert.throws(()=>f.engine.execute({type:'apply-obligation-policy',project:'p',scope:reference(f.scope),policy}),{code:'obligation_application_busy'});
 assert.throws(()=>f.engine.execute({type:'recover-runtime-observation',project:'p',observation:reference(active)}),{code:'runtime_observation_busy'});
 await assert.rejects(researchCall(f.environment.value.implementer,f.environment.value,'Do not dispatch during observation',{},undefined,
  {store:f.store,draftId:f.draft.id,questionId:f.question.id,purpose:'analyst'}),{code:'runtime_observation_busy'});
 assert.equal(f.store.list('model-call').length,0);
 }finally{writeFileSync(f.marker+'.release','release');completed=await pending;}
 assert.equal(completed.observation.value.status,'observed');assert.equal(readFileSync(f.marker,'utf8'),'executed\n');
});

test('changes during execution preserve the captured result but publish no current source',async t=>{
 const f=fixture(t,'wait',0,10000),pending=f.observe();
 await until(()=>Boolean(f.store.list<RuntimeObservation>('runtime-observation')[0]?.value.child));
 writeFileSync(f.helper,"export const tag='changed-after-start';\n");writeFileSync(f.marker+'.release','release');
 const result=await pending;assert.equal(result.observation.value.status,'stale');assert.equal(result.source,null);
 assert.match(result.observation.value.result!.stdout,/pinned-original/);assert.equal(existsSync(result.observation.value.snapshot!),false);
 assert.equal(f.store.list<Source>('source').filter(s=>s.value.provenance).length,0);
});

test('timeout cannot produce evidence and retrying its operation key cannot silently rerun the program',async t=>{
 const f=fixture(t,'positive',1000,100),result=await f.observe();
 assert.equal(result.observation.value.status,'failed');assert.match(result.observation.value.error!,/process_timeout/);assert.equal(result.source,null);
 assert.deepEqual(await f.observe(),result);assert.equal(existsSync(result.observation.value.snapshot!),false);
});

test('missing or foreign declarations and extra executable parameters are refused before execution',async t=>{
 const f=fixture(t);
 assert.throws(()=>f.engine.execute({type:'observe-runtime',project:'p',scope:reference(f.scope),obligation:'boundary',key:'one',command:{executable:'bad',args:[]}}),{code:'command_invalid'});
 await assert.rejects(f.engine.execute({type:'observe-runtime',project:'p',scope:reference(f.scope),obligation:'unknown',key:'one'}) as Promise<unknown>,{code:'obligation_policy_incomplete'});
 await assert.rejects(f.engine.execute({type:'observe-runtime',project:'p',scope:{...reference(f.scope),hash:'0'.repeat(64)},obligation:'boundary',key:'one'}) as Promise<unknown>,{code:'runtime_observation_scope_stale'});
 assert.equal(f.store.list('runtime-observation').length,0);assert.equal(existsSync(f.marker),false);
 rmSync(f.subject);
 await assert.rejects(f.observe(),{code:'runtime_subject_invalid'});
 assert.equal(f.store.list('runtime-observation').length,0);
});

test('recovery checks PID identity, preserves other processes and releases an interrupted observation',async t=>{
 const f=fixture(t),result=await f.observe();
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(child,'spawn');
 const pid=child.pid!;let started:string|null=null;await until(()=>Boolean(started=processStart(pid)));
 t.after(()=>{if(processStart(pid)===started)try{process.kill(-pid,'SIGKILL');}catch{}});
 const interrupted=f.store.write<RuntimeObservation>({id:result.observation.id,kind:'runtime-observation',expected:result.observation.revision,value:{...result.observation.value,status:'running',owner:{pid:2147483647,started:'ended-owner'},child:{pid,started:'different-process'}}});
 const recovered=f.engine.execute({type:'recover-runtime-observation',project:'p',observation:reference(interrupted)}) as typeof interrupted;
 assert.equal(recovered.value.status,'failed');assert.equal(processStart(pid),started,'A recycled PID must not be killed');
 const actual=f.store.write<RuntimeObservation>({id:recovered.id,kind:recovered.kind,expected:recovered.revision,value:{...recovered.value,status:'running',child:{pid,started:started!}}});
 const closed=f.engine.execute({type:'recover-runtime-observation',project:'p',observation:reference(actual)}) as typeof actual;
 assert.equal(closed.value.status,'failed');await until(()=>processStart(pid)!==started);
 assert.equal(closed.value.child,null);
});
