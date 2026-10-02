import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/storage/store.js';
import { ProductEngine } from '../src/product/engine.js';
import { reference } from '../src/pipeline/contracts.js';
import { git } from '../src/runtime/environment.js';
import { runProcess } from '../src/runtime/process.js';
import { runtimeContext, type RuntimeObservationResult } from '../src/runtime/runtime-observation.js';
import { configureReaderPilot } from '../src/discovery/reader-pilot.js';
import { researchCall } from '../src/discovery/research-protocol.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import type { RuntimeCheck } from '../src/graph/obligation-policy.js';
import { digest } from '../src/canonical.js';

const projectRoot=process.cwd(),modulePath=resolve('scripts/runtime-checks/omg-runtime-check.mjs');
const originalPath=process.env['PATH'],originalHome=process.env['HOME'];
const {materialize}=await import(pathToFileURL(resolve('scripts/runtime-checks/materialize-policy.mjs')).href);

function fixture(t:test.TestContext,brokenSandbox=false,provider:'codex'|'devin'='codex',
  options:{unknownAdapter?:boolean;executables?:(index:number)=>string[]}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'omg-check-module-'))),workspace=join(root,'repo'),home=join(root,'home'),bin=join(root,'bin');
  for(const path of [workspace,home,bin])mkdirSync(path);
  const store=new Store(join(root,'db.sqlite')),engine=new ProductEngine(store);
  t.after(()=>{process.env['PATH']=originalPath;process.env['HOME']=originalHome;store.close();rmSync(root,{recursive:true,force:true});});
  process.env['PATH']=bin+delimiter+(originalPath??'');process.env['HOME']=home;
  git(workspace,['init','-b','main']);writeFileSync(join(workspace,'README.md'),'fixture\n');git(workspace,['add','.']);
  git(workspace,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','baseline']);
  // The codex fixture keeps its lawful wrapper name adapter.mjs: an unrecognized module is
  // classified only through the declared executable set, never renamed to match the table.
  const codex=join(bin,provider),adapter=join(workspace,provider==='devin'&&!options.unknownAdapter?'devin-stdio.js':'adapter.mjs'),
    native=join(root,'native-fixture.bin'),log=join(root,'calls.log'),declared=(i:number)=>(options.executables?options.executables(i):[provider]);
  writeFileSync(native,'native fixture bytes');
  writeFileSync(codex,`#!${process.execPath}\nimport{spawnSync}from'node:child_process';import{readFileSync,appendFileSync}from'node:fs';const args=process.argv.slice(2);if(args[0]==='--version'){console.log(${JSON.stringify(provider==='devin'?'devin 3000.11.3 (fixture)':'codex-cli fixture-1')});}else if(args[0]==='sandbox'){if(${brokenSandbox}){console.error('sandbox_apply: fixture denial');process.exitCode=71;}else{const separator=args.indexOf('--');if(args[1]!=='-c'||separator<0)throw Error('wrong sandbox form');const r=spawnSync(args[separator+1],args.slice(separator+2),{encoding:'utf8'});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exitCode=r.status??1;}}else{appendFileSync(${JSON.stringify(log)},'provider\\n');const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'Fixture'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));}\n`);chmodSync(codex,0o700);
  writeFileSync(adapter,`import{spawnSync}from'node:child_process';import{readFileSync}from'node:fs';const r=spawnSync(${JSON.stringify(provider)},['exec'],{input:readFileSync(0,'utf8'),encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status??1;\n`);
  engine.execute({type:'create-project',project:'p',title:'Module fixture'});
  const command={executable:process.execPath,args:[adapter]};
  const environment=engine.environments.configure('p',{workspace,implementer:{actor:'reader',model:'fixture',effort:'high',command},
    reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:{executable:process.execPath,args:['--version']},timeoutMs:5000},0);
  const graph={nodes:[{id:'n'}]},layer=store.write({id:'graph-layer:p:2',kind:'graph-layer',expected:0,value:{projection:graph}});
  const modes=['isolation','isolation','platform','provider','integration'],ids=['boundary-a','boundary-b','platform','provider','integration'];
  const gaps=ids.map(id=>({id,target:'n',consumer:'compilation',field:'tests',requiredFor:'next' as const,question:`Observe ${id}`}));
  const r1=store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:'p',fields:{technical:{gaps}}}});
  const phase=store.write({id:'phase:p:R1',kind:'phase',expected:0,value:{draft:reference(r1)}});
  const original=configureResearchScope(store,{projectId:'p',layer:reference(layer),r1:reference(phase),outcome:'Module fixture',nodes:['n'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
    obligations:gaps.map(gap=>({gap,state:'active',reason:'Fixture',wake:null}))},0);
  const source=engine.discovery.evidence.document('p','module',readFileSync(modulePath,'utf8'),'text/plain',0);
  const scope=configureResearchScope(store,{...original.value,policy:{version:1,sourceScope:reference(original),assignments:gaps.map((gap,i)=>{
    const condition=i<2?null:`Before R3, check ${gap.id}`;
    const runtimeCheck:RuntimeCheck={script:reference(source),dependencies:[],subjects:[adapter,native],executables:declared(i),
      args:[modes[i]!,...(i>2?[store.path]:[])],timeoutMs:60000,purpose:gap.question,...(condition?{satisfies:condition}:{})};
    return{obligation:gap.id,original:{record:reference(original),pointer:`/obligations/${i}/gap`},kind:'environment-confirmation',moment:i<2?'R2':'R3',
      responsibleNode:gap.target,responsibleConsumer:gap.consumer,neededForR2:i<2,reason:'Explicit fixture rule',returnCondition:condition,runtimeCheck};
  })}},1);
  const draft=engine.discovery.create('p','om-g2','R2','compilation',[{field:'fixture',kind:'design',proof:'assessment',prompt:'Fixture research',risk:'Wrong evidence',schema:{type:'string'}}],[reference(scope)]);
  const invoke=()=>researchCall(environment.value.implementer,environment.value,'Fixture',{fixture:true},undefined,{store,draftId:draft.id,questionId:draft.value.questions[0]!,purpose:'analyst'});
  const observe=(obligation:string,key=obligation)=>engine.execute({type:'observe-runtime',project:'p',scope:reference(scope),obligation,key}) as Promise<RuntimeObservationResult>;
  const run=async(mode:string,obligation=mode)=>{
    const assignment=scope.value.policy!.assignments.find(item=>item.obligation===obligation)!;
    const input={protocol:'omg-runtime-observation/v1',scope:reference(scope),obligation:assignment.original,runtime:runtimeContext(store,'p').binding,
      executables:[...new Set(scope.value.policy!.assignments.flatMap(item=>item.runtimeCheck?item.runtimeCheck.executables:[]))].sort()};
    const result=await runProcess({executable:process.execPath,args:[modulePath,mode,...(['provider','integration'].includes(mode)?[store.path]:[])]},workspace,JSON.stringify(input),20000);
    return{...result,payload:JSON.parse(result.stdout)};
  };
  return{root,workspace,home,bin,store,engine,environment,scope,source,native,adapter,codex,log,draft,invoke,observe,run};
}

test('isolation module records direct and descendant permissions, including unexpected allowed access, without changing existing files',async t=>{
  const f=fixture(t),before=readFileSync(join(f.workspace,'.git','config'));
  const result=await f.observe('boundary-a');assert.equal(result.observation.value.result!.exitCode,0);
  const report=JSON.parse(result.observation.value.result!.stdout).result;
  assert.equal(report.kind,'isolation-observation');assert.equal(report.matrix.length,2);
  for(const row of report.matrix){
    assert.equal(row.observation.files.length,6);assert.equal(row.observation.descendant.files.length,6);
    assert.equal(row.observation.files.find((item:any)=>item.id==='outside-task-write').allowed,true,'A fixture allowance is not silently relabeled as denied');
    assert.equal(row.observation.files.find((item:any)=>item.id==='home-canary-read').matches,true);
  }
  assert.deepEqual(readFileSync(join(f.workspace,'.git','config')),before);
  assert.ok(!readdirSync(f.workspace).some(name=>name.startsWith('.omg-canary-')));
  assert.ok(!readdirSync(f.home).some(name=>name.startsWith('.omg-canary-')));
  assert.equal(f.store.list('model-call').length,0);
});

test('sandbox_apply failure stays a failed observation with the actual partial result, never a positive isolation proof',async t=>{
  const f=fixture(t,true),result=await f.observe('boundary-a');
  assert.equal(result.observation.value.result!.exitCode,1);
  const report=JSON.parse(result.observation.value.result!.stdout);
  assert.equal(report.error,'sandbox_observation_incomplete');assert.equal(report.observation.completed,false);
  assert.equal(report.observation.matrix[0].result.exitCode,71);assert.match(report.observation.matrix[0].result.stderr,/fixture denial/);
});

test('platform module exercises process identity and process-group signalling without calling a provider',async t=>{
  const f=fixture(t),result=await f.run('platform');
  assert.equal(result.exitCode,0);assert.equal(result.payload.result.completed,true);
  assert.equal(JSON.parse(result.payload.result.group.stdout).signal,'SIGTERM');
  assert.equal(f.store.list('model-call').length,0);
});

test('compatibility needs a current successful ordinary R2 call and exact archived protocol, not old status or model cache',async t=>{
  const f=fixture(t);assert.equal((await f.run('provider')).payload.error,'compatible_call_unavailable');
  await f.invoke();const good=await f.run('provider');assert.equal(good.exitCode,0);
  assert.equal(good.payload.result.calls.length,1);assert.equal(good.payload.result.calls[0].mode,'research');
  assert.equal(f.store.list('model-call').length,1);assert.equal(readFileSync(f.log,'utf8'),'provider\n');
  const call=f.store.list<ModelCall>('model-call')[0]!,saved=call.value.response!.record!;
  const row=f.store.get<any>(saved.id)!;
  f.store.write({id:row.id,kind:row.kind,expected:row.revision,value:{...row.value,text:'{"protocol":"omg-agent/v1","requestId":"foreign","research":{}}'}});
  // Exact historical response is still available: a new unrelated head must
  // not replace the request/response captured by this immutable call.
  assert.equal((await f.run('provider')).exitCode,0);
  const updated=f.store.get<ModelCall>(call.id)!;
  f.store.write<ModelCall>({id:call.id,kind:call.kind,expected:updated.revision,
    value:{...updated.value,response:{...updated.value.response!,record:reference(f.store.get(saved.id)!)}}});
  assert.equal((await f.run('provider')).payload.error,'compatible_call_unavailable');
});

test('lost native subject, missing CLI version or changed adapter cannot pass the compatibility module',async t=>{
  const f=fixture(t);await f.invoke();const baseline=f.store.list<ModelCall>('model-call')[0]!;
  for(const mutate of [(v:any)=>{v.runtime.snapshot.subjects=v.runtime.snapshot.subjects.filter((s:any)=>s.path!==f.native);},
    (v:any)=>{delete v.runtime.snapshot.codex;},(v:any)=>{v.runtime.requestHash='0'.repeat(64);},(v:any)=>{v.runtime.status='unavailable';}]){
    const value=structuredClone(baseline.value);mutate(value);
    f.store.write({id:baseline.id,kind:baseline.kind,expected:f.store.get(baseline.id)!.revision,value});
    assert.equal((await f.run('provider')).payload.error,'compatible_call_unavailable');
  }
  f.store.write({id:baseline.id,kind:baseline.kind,expected:f.store.get(baseline.id)!.revision,value:baseline.value});
  writeFileSync(f.adapter,readFileSync(f.adapter,'utf8')+'\n// changed\n');
  assert.equal((await f.run('provider')).payload.error,'compatible_call_unavailable');
});

test('integration requires both current declared isolation observations and leaves failed or missing evidence explicit',async t=>{
  const f=fixture(t);await f.invoke();
  assert.equal((await f.run('integration')).payload.error,'isolation_observation_unavailable');
  await f.observe('boundary-a');await f.observe('boundary-b');
  const result=await f.run('integration');assert.equal(result.exitCode,0);assert.equal(result.payload.result.observations.length,2);
  const observation=f.store.list<any>('runtime-observation').find(row=>row.value.requestedFor==='boundary-a')!;
  f.store.write({id:observation.id,kind:observation.kind,expected:observation.revision,value:{...observation.value,status:'failed'}});
  assert.equal((await f.run('integration')).payload.error,'isolation_observation_unavailable');
});

test('materialized imports match the public source command and the complete 34-obligation policy validator byte for byte',t=>{
  const root=mkdtempSync(join(tmpdir(),'omg-materialize-')),store=new Store(join(root,'db.sqlite')),engine=new ProductEngine(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const matrix=JSON.parse(readFileSync(resolve(projectRoot,'PREPARATIONS/POST-AUDIT-DISCUSSION/P1-OBLIGATION-ASSIGNMENTS.json'),'utf8'));
  // The audit report is an operator input, not a tracked test dependency.
  const report=join(root,'audit-fixture.txt');writeFileSync(report,'Fixture report: physical user_version 1; this is not runtime evidence.');
  matrix.runtimeAssets.document.path=report;
  const project='omg-live';engine.execute({type:'create-project',project,title:'Materialization fixture'});
  const gaps=matrix.obligations.map((item:any)=>item.gap),nodes=[...new Set(gaps.map((gap:any)=>gap.target))].map(id=>({id}));
  const layer=store.write({id:`graph-layer:${project}:2`,kind:'graph-layer',expected:0,value:{projection:{nodes}}});
  const r1=store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:project,fields:{technical:{gaps}}}});
  const phase=store.write({id:`phase:${project}:R1`,kind:'phase',expected:0,value:{draft:reference(r1)}});
  const original=configureResearchScope(store,{projectId:project,layer:reference(layer),r1:reference(phase),outcome:'Fixture',nodes:nodes.map(node=>node.id as string),boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
    obligations:matrix.obligations.map((item:any)=>({gap:item.gap,state:item.originalState,reason:item.rationale,wake:item.originalWake}))},0);
  matrix.sourceScope=reference(original);for(const item of matrix.obligations)item.original.record=reference(original);
  const result=materialize(matrix,projectRoot);
  assert.throws(()=>configureResearchScope(store,{...original.value,policy:result.policy},1),{code:'obligation_runtime_check_invalid'});
  for(const source of result.imports){
    const actual=engine.execute(source.command) as any;assert.deepEqual(reference(actual),source.ref);
    assert.equal(actual.value.sha256,digest(source.content));
  }
  const applied=configureResearchScope(store,{...original.value,policy:result.policy},1);
  assert.equal(applied.value.policy!.assignments.length,34);
  assert.equal(applied.value.policy!.assignments.filter(item=>item.runtimeCheck).length,5);
  assert.equal(applied.value.policy!.assignments.filter(item=>item.runtimeCheck?.satisfies).length,3);
  assert.equal(store.list('model-call').length,0);
  assert.ok(result.matrix.obligations.filter((item:any)=>item.runtimeModule).every((item:any)=>item.runtimeModule.sha256===digest(readFileSync(modulePath))));
  assert.throws(()=>materialize({...matrix,runtimeAssets:null},projectRoot),/runtime_assets_missing/);
});

test('a Devin provider exercises version 2 telemetry, its own version check and an explicit sandbox refusal',async t=>{
  const f=fixture(t,false,'devin');
  // The platform check probes the declared devin executable, never a codex one.
  const platform=await f.run('platform');assert.equal(platform.exitCode,0);
  assert.equal(platform.payload.result.versions.devin.result.stdout.trim(),'devin 3000.11.3 (fixture)');
  assert.equal(Object.hasOwn(platform.payload.result.versions,'codex'),false,'a codex probe is not claimed for a devin runtime');
  // Devin has no local sandbox command to certify: the refusal is explicit and is never completed:true.
  const refused=await f.observe('boundary-a');assert.equal(refused.observation.value.result!.exitCode,1);
  assert.equal(JSON.parse(refused.observation.value.result!.stdout).error,'sandbox_provider_unsupported');
  assert.equal(f.store.list('model-call').length,0);
  // An ordinary version-2 call satisfies the provider check under the provider field.
  await f.invoke();const good=await f.run('provider');assert.equal(good.exitCode,0);
  assert.equal(good.payload.result.calls[0].provider.protocol,'devin-stdio');
  const call=f.store.list<ModelCall>('model-call')[0]!;
  assert.equal(call.value.runtime!.version,2);
  // Neither a codex-era field nor an unknown version is accepted as Devin evidence.
  const baseline=call.value;
  for(const mutate of [(v:any)=>{v.runtime.version=3;},(v:any)=>{v.runtime.snapshot.provider.protocol='codex-stdio';},
    (v:any)=>{const s=v.runtime.snapshot,v2={...s.codex?{}:{provider:s.provider}};delete s.provider;s.codex={executable:v2.provider.executable,args:['--version'],result:v2.provider.result};}]) {
    const value=structuredClone(baseline);mutate(value);
    f.store.write({id:call.id,kind:call.kind,expected:f.store.get(call.id)!.revision,value});
    assert.equal((await f.run('provider')).payload.error,'compatible_call_unavailable');
  }
  f.store.write({id:call.id,kind:call.kind,expected:f.store.get(call.id)!.revision,value:baseline});
  // A Codex canary observation is not counted as Devin isolation in the integration check.
  const integration=await f.run('integration');assert.equal(integration.payload.error,'isolation_observation_unavailable');
});

const devinModule=resolve('dist/src/adapters/devin-stdio.js');
const pilotSettings=(command:{executable:string;args:string[]},agentCommand:{executable:string;args:string[]})=>({
  experimental:true,active:true,stopAfter:'L2',
  reader:{actor:'dedicated-reader',model:'swe-2-high',effort:'high',speed:'inherited',command},
  agentCommand,maxRequestChars:300000,maxReadChars:10000,maxReplyChars:10000,maxCalls:100,maxReportedTokens:1000000});

test('a Devin pilot reader alone makes the Codex canary an explicit refusal, and platform probes its provider',async t=>{
  const f=fixture(t);
  // The main roles and the agent command stay Codex; only the dedicated reader runs the Devin adapter.
  writeFileSync(join(f.bin,'devin'),`#!${process.execPath}\nconsole.log('devin 3000.11.3 (fixture)');\n`,{mode:0o700});
  configureReaderPilot(f.store,f.engine.environments,'p',
    pilotSettings({executable:process.execPath,args:[devinModule]},f.environment.value.implementer.command),0);
  const refused=await f.run('isolation','boundary-a');
  assert.equal(refused.payload.error,'sandbox_provider_unsupported');
  assert.equal(refused.exitCode,1,'Codex sandbox evidence never certifies a Devin reader');
  const platform=await f.run('platform');assert.equal(platform.exitCode,0);
  assert.equal(platform.payload.result.versions.devin.result.stdout.trim(),'devin 3000.11.3 (fixture)');
  assert.equal(platform.payload.result.versions.codex.result.stdout.trim(),'codex-cli fixture-1');
});

test('pilot.agentCommand substitutes the main roles when providers are collected; the reader is counted separately',async t=>{
  const f=fixture(t);
  const codexCommand=f.environment.value.implementer.command,devinCommand={executable:process.execPath,args:[devinModule]};
  const environment=f.environment.value;
  // Both main roles run the Devin adapter module, but the pilot's agent command substitutes Codex for them.
  f.engine.environments.configure('p',{...environment,
    implementer:{...environment.implementer,command:devinCommand},reviewer:{...environment.reviewer,command:devinCommand}},
    f.environment.revision);
  configureReaderPilot(f.store,f.engine.environments,'p',pilotSettings(codexCommand,codexCommand),0);
  const allowed=await f.run('isolation','boundary-a');
  assert.equal(allowed.exitCode,0,'the agent command replaces the Devin roles, and the Codex reader keeps the canary lawful');
  assert.equal(allowed.payload.result.completed,true);
  // Substituting Devin instead reclassifies both roles; a Codex canary cannot prove them.
  configureReaderPilot(f.store,f.engine.environments,'p',pilotSettings(codexCommand,devinCommand),1);
  const refused=await f.run('isolation','boundary-a');
  assert.equal(refused.payload.error,'sandbox_provider_unsupported');
});

test('a pilot agent command is classified even when environment roles are absent from the runtime input',async t=>{
  const f=fixture(t);
  writeFileSync(join(f.bin,'devin'),`#!${process.execPath}\nconsole.log('devin 3000.11.3 (fixture)');\n`,{mode:0o700});
  const codexCommand=f.environment.value.implementer.command,devinCommand={executable:process.execPath,args:[devinModule]};
  configureReaderPilot(f.store,f.engine.environments,'p',pilotSettings(codexCommand,devinCommand),0);
  const assignment=f.scope.value.policy!.assignments.find(item=>item.obligation==='boundary-a')!;
  const binding=runtimeContext(f.store,'p').binding as Record<string,unknown>;
  // The standalone module accepts external runtime input: with no environment roles the agent
  // command is still the provider that would serve a main-role call, so it is classified
  // rather than silently replaced by the codex default.
  const input={protocol:'omg-runtime-observation/v1',scope:reference(f.scope),obligation:assignment.original,
    runtime:{...binding,environment:{projectId:'p'}},executables:['codex']};
  const result=await runProcess({executable:process.execPath,args:[modulePath,'isolation']},f.workspace,JSON.stringify(input),20000);
  assert.equal(result.exitCode,1);
  assert.equal(JSON.parse(result.stdout).error,'sandbox_provider_unsupported');
});

test('the self-contained check module classifies adapters exactly like the engine table',async()=>{
  const{KNOWN_ADAPTERS}=await import(pathToFileURL(modulePath).href);
  const{STDIO_PROVIDERS}=await import('../src/adapters/stdio-providers.js');
  assert.deepEqual(Object.keys(KNOWN_ADAPTERS).sort(),STDIO_PROVIDERS.map(provider=>provider.module).sort());
  for(const provider of STDIO_PROVIDERS){
    const copy=KNOWN_ADAPTERS[provider.module as keyof typeof KNOWN_ADAPTERS];
    assert.equal(copy.protocol,provider.protocol);
    assert.equal(copy.executable,provider.executable);
    assert.equal(copy.versionPattern.source,provider.versionPattern.source);
    assert.equal(copy.versionPattern.flags,provider.versionPattern.flags);
  }
});

test('the runtime check input refuses a missing or malformed declared executable set',async t=>{
  const f=fixture(t),binding=runtimeContext(f.store,'p').binding;
  const assignment=f.scope.value.policy!.assignments.find(item=>item.obligation==='boundary-a')!;
  const send=async(executables:unknown)=>{
    const input={protocol:'omg-runtime-observation/v1',scope:reference(f.scope),obligation:assignment.original,
      runtime:binding,...(executables===undefined?{}:{executables})};
    const result=await runProcess({executable:process.execPath,args:[modulePath,'isolation']},f.workspace,JSON.stringify(input),20000);
    return{...result,payload:JSON.parse(result.stdout)};
  };
  for(const executables of [undefined,null,'codex',['codex',''],[17]])
    assert.equal((await send(executables)).payload.error,'runtime_input_invalid');
  // An empty declaration is lawful: nothing is declared, so classification has no substitute.
  const empty=await send([]);
  assert.equal(empty.payload.result.completed,true);
});

test('an unrecognized adapter module with a declared foreign provider gets no Codex certification',async t=>{
  const f=fixture(t,false,'devin',{unknownAdapter:true});
  // adapter.mjs is not in the closed table and {devin} is declared: every operator surface
  // refuses instead of certifying or completing over an unprovable provider.
  assert.equal((await f.run('isolation','boundary-a')).payload.error,'sandbox_provider_unsupported');
  assert.equal((await f.run('platform','platform')).payload.error,'runtime_provider_unknown');
  const observation=await f.observe('boundary-a');
  assert.equal(observation.observation.value.status,'observed');
  assert.equal(JSON.parse(observation.observation.value.result!.stdout).error,'sandbox_provider_unsupported');
});

test('an unrecognized adapter module with no foreign declared executable keeps the Codex-era probes',async t=>{
  const f=fixture(t,false,'codex',{executables:()=>[]});
  // adapter.mjs + declared ∅: the Codex-era canary and version probe run exactly as before.
  assert.equal((await f.run('isolation','boundary-a')).payload.result.completed,true);
  assert.equal((await f.run('platform','platform')).payload.result.versions.codex.result.stdout.trim(),'codex-cli fixture-1');
});

test('a foreign provider declared by a sibling assignment keeps an unknown adapter unprovable',async t=>{
  // boundary-a itself declares only codex, but the same scope declaration names devin on a
  // sibling: the union for classification is declaration-level, not per-check.
  const f=fixture(t,false,'codex',{executables:i=>i===0?['codex']:['codex','devin']});
  const observation=await f.observe('boundary-a');
  assert.equal(observation.observation.value.status,'observed');
  assert.equal(JSON.parse(observation.observation.value.result!.stdout).error,'sandbox_provider_unsupported');
});

test('provider evidence refuses a declaration set the stored scope does not name',async t=>{
  const f=fixture(t);
  const assignment=f.scope.value.policy!.assignments.find(item=>item.obligation==='provider')!;
  const input={protocol:'omg-runtime-observation/v1',scope:reference(f.scope),obligation:assignment.original,
    runtime:runtimeContext(f.store,'p').binding,executables:['codex','nope']};
  const result=await runProcess({executable:process.execPath,args:[modulePath,'provider',f.store.path]},f.workspace,JSON.stringify(input),20000);
  assert.equal(result.exitCode,1);
  assert.equal(JSON.parse(result.stdout).error,'runtime_input_invalid');
});
