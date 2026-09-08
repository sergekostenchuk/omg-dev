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
import { researchCall } from '../src/discovery/research-protocol.js';
import { configureResearchScope } from '../src/graph/research-scope.js';
import type { ModelCall } from '../src/runtime/model-usage.js';
import type { RuntimeCheck } from '../src/graph/obligation-policy.js';
import { digest } from '../src/canonical.js';

const projectRoot=process.cwd(),modulePath=resolve('scripts/runtime-checks/omg-runtime-check.mjs');
const originalPath=process.env['PATH'],originalHome=process.env['HOME'];
const {materialize}=await import(pathToFileURL(resolve('scripts/runtime-checks/materialize-policy.mjs')).href);

function fixture(t:test.TestContext,brokenSandbox=false){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'omg-check-module-'))),workspace=join(root,'repo'),home=join(root,'home'),bin=join(root,'bin');
  for(const path of [workspace,home,bin])mkdirSync(path);
  const store=new Store(join(root,'db.sqlite')),engine=new ProductEngine(store);
  t.after(()=>{process.env['PATH']=originalPath;process.env['HOME']=originalHome;store.close();rmSync(root,{recursive:true,force:true});});
  process.env['PATH']=bin+delimiter+(originalPath??'');process.env['HOME']=home;
  git(workspace,['init','-b','main']);writeFileSync(join(workspace,'README.md'),'fixture\n');git(workspace,['add','.']);
  git(workspace,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','baseline']);
  const codex=join(bin,'codex'),adapter=join(workspace,'adapter.mjs'),native=join(root,'native-fixture.bin'),log=join(root,'calls.log');
  writeFileSync(native,'native fixture bytes');
  writeFileSync(codex,`#!${process.execPath}\nimport{spawnSync}from'node:child_process';import{readFileSync,appendFileSync}from'node:fs';const args=process.argv.slice(2);if(args[0]==='--version'){console.log('codex-cli fixture-1');}else if(args[0]==='sandbox'){if(${brokenSandbox}){console.error('sandbox_apply: fixture denial');process.exitCode=71;}else{const separator=args.indexOf('--');if(args[1]!=='-c'||separator<0)throw Error('wrong sandbox form');const r=spawnSync(args[separator+1],args.slice(separator+2),{encoding:'utf8'});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exitCode=r.status??1;}}else{appendFileSync(${JSON.stringify(log)},'provider\\n');const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'Fixture'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));}\n`);chmodSync(codex,0o700);
  writeFileSync(adapter,`import{spawnSync}from'node:child_process';import{readFileSync}from'node:fs';const r=spawnSync('codex',['exec'],{input:readFileSync(0,'utf8'),encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status??1;\n`);
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
    const runtimeCheck:RuntimeCheck={script:reference(source),dependencies:[],subjects:[adapter,native],executables:['codex'],
      args:[modes[i]!,...(i>2?[store.path]:[])],timeoutMs:60000,purpose:gap.question,...(condition?{satisfies:condition}:{})};
    return{obligation:gap.id,original:{record:reference(original),pointer:`/obligations/${i}/gap`},kind:'environment-confirmation',moment:i<2?'R2':'R3',
      responsibleNode:gap.target,responsibleConsumer:gap.consumer,neededForR2:i<2,reason:'Explicit fixture rule',returnCondition:condition,runtimeCheck};
  })}},1);
  const draft=engine.discovery.create('p','om-g2','R2','compilation',[{field:'fixture',kind:'design',proof:'assessment',prompt:'Fixture research',risk:'Wrong evidence',schema:{type:'string'}}],[reference(scope)]);
  const invoke=()=>researchCall(environment.value.implementer,environment.value,'Fixture',{fixture:true},undefined,{store,draftId:draft.id,questionId:draft.value.questions[0]!,purpose:'analyst'});
  const observe=(obligation:string,key=obligation)=>engine.execute({type:'observe-runtime',project:'p',scope:reference(scope),obligation,key}) as Promise<RuntimeObservationResult>;
  const run=async(mode:string,obligation=mode)=>{
    const assignment=scope.value.policy!.assignments.find(item=>item.obligation===obligation)!;
    const input={protocol:'omg-runtime-observation/v1',scope:reference(scope),obligation:assignment.original,runtime:runtimeContext(store,'p').binding};
    const result=await runProcess({executable:process.execPath,args:[modulePath,mode,...(['provider','integration'].includes(mode)?[store.path]:[])]},workspace,JSON.stringify(input),20000);
    return{...result,payload:JSON.parse(result.stdout)};
  };
  return{root,workspace,home,store,engine,environment,scope,source,native,adapter,codex,log,draft,invoke,observe,run};
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
