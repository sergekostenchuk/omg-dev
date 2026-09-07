import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {git} from '../src/runtime/environment.js';
import {processStart} from '../src/runtime/process-identity.js';
import {reference} from '../src/pipeline/contracts.js';
import type {DiscoveryDraft} from '../src/discovery/discovery.js';
import type {Graph} from '../src/graph/model.js';
import {preparedFeatures} from './product-fixture.js';
import {answerTechnicalFixture} from './technical-research-fixture.js';
import {answerLayerFixture,deriveLayerFixture} from './layer-design-fixture.js';

function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'omg-preparation-run-')),workspace=join(root,'repo');mkdirSync(workspace);
 git(workspace,['init','-b','main']);writeFileSync(join(workspace,'README.md'),'Local stateless product\n');
 git(workspace,['add','README.md']);git(workspace,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);
 const path=join(root,'db.sqlite'),store=new Store(path),engine=new ProductEngine(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 preparedFeatures(engine,'p');
 const command={executable:process.execPath,args:['--version']};
 engine.environments.configure('p',{workspace,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:1000},0);
 for(const level of ['R0','R1'] as const){
  const draft=engine.refinement.begin('p',level);if(level==='R1')answerTechnicalFixture(engine,'p',draft);
  engine.refinement.finishResearch('p',level,reference(store.get(draft.id)!),0);
  if(level==='R1')deriveLayerFixture(engine,'p',2);
  engine.refinement.sealLayer('p',level==='R0'?1:2,0);
 }
 const visited:string[]=[];
 const original=engine.refinementResearch.run.bind(engine.refinementResearch);
 // Seed explicit fixture answers, then run the real phase consumer and all
 // acceptance/graph/repository/compiler checks. Model semantics have separate tests.
 engine.refinementResearch.run=async(project,phase,draftId,maxTurns)=>{
  visited.push(phase);const draft=store.get<DiscoveryDraft>(draftId)!;
  if(phase==='R2')answerTechnicalFixture(engine,project,draft);
  else answerLayerFixture(engine,project,draft,3,store.get<Graph>('graph:p')!.value);
  return original(project,phase,draftId,maxTurns);
 };
 return {store,engine,workspace,path,visited};
}
test('one product command traverses R2, L3, R3 and compilation, stops at the exact accepted plan, and resumes idempotently',async t=>{
 const f=fixture(t),run=await f.engine.execute({type:'continue-preparation',project:'p',maxCalls:5}) as any;
 assert.equal(run.value.status,'accepted',JSON.stringify(run.value));assert.deepEqual(f.visited,['R2','L3']);
 assert.deepEqual((f.engine.pipeline.inspect('p','compilation').artifact!.value.content as any).plan,run.value.plan);
 assert.equal(f.store.list('run').length,0);assert.equal(f.store.list('model-call').length,0);
 assert.equal(existsSync(join(f.workspace,'produce.txt')),false);
 const db=new Store(f.path);try{
  const again=await new ProductEngine(db).execute({type:'continue-preparation',project:'p',maxCalls:5}) as any;
  assert.equal(again.value.status,'accepted');assert.deepEqual(again.value.plan,run.value.plan);assert.equal(db.list('plan').length,1);
 }finally{db.close();}
});
test('an existing stale phase cannot be skipped to reach later phases or buy another call',async t=>{
 const f=fixture(t),draft=f.engine.refinement.begin('p','R2');answerTechnicalFixture(f.engine,'p',draft);
 f.engine.refinement.finishResearch('p','R2',reference(f.store.get(draft.id)!),0);
 f.engine.discovery.evidence.document('p','brief','Changed accepted input','text/plain',1);
 const run=await f.engine.execute({type:'continue-preparation',project:'p',maxCalls:5}) as any;
 assert.equal(run.value.status,'paused');assert.equal(run.value.code,'phase_not_ready');
 assert.deepEqual(f.visited,[]);assert.equal(f.store.get('phase:p:L3'),null);assert.equal(f.store.list('plan').length,0);
});
test('a dirty repository stops at R3 without publishing a plan',async t=>{
 const f=fixture(t);writeFileSync(join(f.workspace,'uncommitted.txt'),'uncommitted');
 const run=await f.engine.execute({type:'continue-preparation',project:'p',maxCalls:5}) as any;
 assert.equal(run.value.status,'paused');assert.equal(run.value.code,'feasibility_not_ready');
 assert.ok(run.value.findings.some((x:any)=>x.code==='repository_dirty'));assert.equal(f.store.list('plan').length,0);
});
test('preparation refuses a live competing owner and malformed commands before research',async t=>{
 const f=fixture(t);
 for(const command of [{type:'continue-preparation',project:'p'},{type:'continue-preparation',project:'p',maxCalls:0},{type:'continue-preparation',project:'p',maxCalls:101}])
  assert.throws(()=>f.engine.execute(command),{code:'command_invalid'});
 f.store.write({id:'preparation-run:p',kind:'preparation-run',expected:0,value:{projectId:'p',status:'running',owner:{pid:process.pid,started:processStart(process.pid)}}});
 await assert.rejects(f.engine.execute({type:'continue-preparation',project:'p',maxCalls:1}) as Promise<unknown>,{code:'preparation_busy'});
 assert.deepEqual(f.visited,[]);
 const prior=f.store.get('preparation-run:p')!;
 f.store.write({id:prior.id,kind:prior.kind,expected:prior.revision,value:{projectId:'p',status:'running'}});
 await assert.rejects(f.engine.execute({type:'continue-preparation',project:'p',maxCalls:1}) as Promise<unknown>,{code:'preparation_identity_missing'});
});
