import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,type Write,type ReadGuard} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference} from '../src/pipeline/contracts.js';
import {hashJson,type Json} from '../src/canonical.js';
import {configureResearchScope,expandResearchScope,type ResearchScope} from '../src/graph/research-scope.js';
import {applyObligationPolicy} from '../src/graph/obligation-application.js';
import type {ObligationPolicy} from '../src/graph/obligation-policy.js';
import {researchCall} from '../src/discovery/research-protocol.js';

class RaceStore extends Store {
 beforeCommit:(()=>void)|undefined;
 override writeMany<T=Json>(writes:Write[],guards:ReadGuard[]=[]){
  const callback=this.beforeCommit;this.beforeCommit=undefined;callback?.();
  return super.writeMany<T>(writes,guards);
 }
}
function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'omg-policy-apply-')),path=join(root,'db.sqlite'),store=new RaceStore(path);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Policy application'});
 const layer=store.write({id:'graph-layer:p:2',kind:'graph-layer',expected:0,value:{projection:{nodes:[{id:'n'},{id:'extra'}]}}});
 const gaps=['now','later'].map(id=>({id,target:'n',field:'code',consumer:'compilation',question:id,requiredFor:'next' as const}));
 const draft=store.write({id:'r1',kind:'discovery-draft',expected:0,value:{projectId:'p',fields:{technical:{gaps}}}});
 const r1=store.write({id:'phase:p:R1',kind:'phase',expected:0,value:{draft:reference(draft)}});
 const scope=configureResearchScope(store,{projectId:'p',layer:reference(layer),r1:reference(r1),outcome:'recover',nodes:['n'],boundaries:[],expansions:[],changedPaths:[],uiRequired:false,
  obligations:gaps.map(gap=>({gap,state:'active',reason:'original',wake:null}))},0);
 const policy:ObligationPolicy={version:1,sourceScope:reference(scope),assignments:gaps.map((g,i)=>({obligation:g.id,original:{record:reference(scope),pointer:`/obligations/${i}/gap`},kind:i===0?'repository-fact':'environment-confirmation',moment:i===0?'R2':'R3',responsibleNode:g.target,responsibleConsumer:g.consumer,neededForR2:i===0,reason:'Current design can be justified before runtime confirmation',returnCondition:i===0?null:'Before R3 readiness, obtain actual compatible runtime results'}))};
 const command={type:'apply-obligation-policy',project:'p',scope:reference(scope),policy};
 return {root,path,store,engine,scope,policy,command,counter:`project-dispatch:${hashJson('p')}`};
}

test('public command applies one exact revision without changing budgets, calls, accepted inputs or original scope',t=>{
 const f=fixture(t),before=f.store.list();
 const result=f.engine.execute(f.command) as ReturnType<typeof applyObligationPolicy>;
 assert.equal(result.revision,2);assert.deepEqual(result.value.policy,f.policy);
 assert.deepEqual(result.value.obligations,f.scope.value.obligations);
 for(const record of before)assert.deepEqual(f.store.get(record.id,record.revision),record);
 assert.deepEqual(f.store.list('model-call'),[]);assert.deepEqual(f.store.list('research-budget'),[]);
 assert.deepEqual(f.store.get<any>(f.counter)!.value,{projectId:'p',serial:1});
 assert.equal(f.store.list().length,before.length+1,'Only the existing scope head and dispatch counter change');
});

test('lost-response retries and retries after a later expansion return the original successor without rolling back state',t=>{
 const f=fixture(t),applied=f.engine.execute(f.command) as ReturnType<typeof applyObligationPolicy>,counter=f.store.get(f.counter);
 assert.deepEqual(f.engine.execute(f.command),applied);assert.deepEqual(f.store.get(f.counter),counter);
 const expanded=expandResearchScope(f.store,'p',applied.revision,'extra','Later owner expansion');
 assert.deepEqual(f.engine.execute(f.command),applied);
 assert.deepEqual(f.store.get(f.scope.id),expanded);assert.deepEqual(f.store.get(f.counter),counter);
 const sameCurrent={...f.command,scope:reference(expanded)};
 assert.deepEqual(f.engine.execute(sameCurrent),expanded);assert.equal(f.store.get(f.scope.id)!.revision,3);
});

test('missing fields, foreign scope, forged hashes and incomplete assignments fail without writing',t=>{
 const f=fixture(t);
 for(const key of ['scope','policy']){const cmd={...f.command} as any;delete cmd[key];assert.throws(()=>f.engine.execute(cmd),{code:'command_invalid'});}
 assert.throws(()=>f.engine.execute({...f.command,scope:{...f.command.scope,id:'research-scope:other:R2'}}),{code:'obligation_application_invalid'});
 assert.throws(()=>f.engine.execute({...f.command,scope:{...f.command.scope,hash:'0'.repeat(64)}}),{code:'obligation_application_stale'});
 assert.throws(()=>f.engine.execute({...f.command,policy:{...f.policy,assignments:[]}}),{code:'obligation_policy_incomplete'});
 assert.throws(()=>f.engine.execute({...f.command,policy:{...f.policy,extra:true}}),{code:'command_invalid'});
 assert.equal(f.store.get(f.scope.id)!.revision,1);assert.equal(f.store.get(f.counter),null);
});

test('active calls block a new application while finished and foreign-project calls do not',t=>{
 const f=fixture(t),call=f.store.write({id:'running',kind:'model-call',expected:0,value:{projectId:'p',status:'running'}});
 assert.throws(()=>f.engine.execute(f.command),{code:'obligation_application_busy'});
 assert.equal(f.store.get(f.scope.id)!.revision,1);assert.equal(f.store.get(f.counter),null);
 f.store.write({id:call.id,kind:call.kind,expected:call.revision,value:{projectId:'p',status:'succeeded'}});
 f.store.write({id:'foreign',kind:'model-call',expected:0,value:{projectId:'other',status:'running'}});
 assert.equal((f.engine.execute(f.command) as ReturnType<typeof applyObligationPolicy>).revision,2);
});

test('a call inserted after the empty scan rolls back the entire application via the common dispatch counter',t=>{
 const f=fixture(t),other=new Store(f.path);t.after(()=>other.close());
 f.store.beforeCommit=()=>{other.writeMany([{id:'concurrent-call',kind:'model-call',expected:0,value:{projectId:'p',status:'running'}},
  {id:f.counter,kind:'project-dispatch',expected:0,value:{projectId:'p',serial:1}}]);};
 assert.throws(()=>f.engine.execute(f.command),{code:'revision_conflict'});
 assert.deepEqual(f.store.get(f.scope.id),f.scope);
 assert.equal(f.store.get<any>(f.counter)!.value.serial,1);assert.equal(f.store.get(f.scope.id,2),null);
});

test('two identical concurrent applications converge on one scope revision and one counter increment',t=>{
 const f=fixture(t),other=new Store(f.path);t.after(()=>other.close());
 let concurrent:ReturnType<typeof applyObligationPolicy>|undefined;
 f.store.beforeCommit=()=>{concurrent=applyObligationPolicy(other,'p',reference(f.scope),f.policy);};
 const result=f.engine.execute(f.command);
 assert.deepEqual(result,concurrent);assert.equal(f.store.get(f.scope.id)!.revision,2);
 assert.equal(f.store.get<any>(f.counter)!.value.serial,1);
});

test('a packet prepared before application cannot dispatch against the changed scope even without a budget segment',async t=>{
 const f=fixture(t),command={executable:process.execPath,args:['--version']};
 const environment=f.engine.environments.configure('p',{workspace:f.root,implementer:{actor:'author',model:'fixture',effort:'high',command},reviewer:{actor:'reviewer',model:'fixture',effort:'high',command},fullCheck:command,timeoutMs:5000},0);
 const spec={field:'result',kind:'design' as const,prompt:'Research this scope',risk:'Changed basis',schema:{type:'object'}};
 const draft=f.engine.discovery.create('p','om-g2','R2','compilation',[spec],[reference(f.scope)],2),question=draft.value.questions[0]!;
 await assert.rejects(researchCall(environment.value.implementer,environment.value,'Use the prepared scope',{question:{id:question,...spec}},undefined,
  {store:f.store,draftId:draft.id,questionId:question,purpose:'analyst',onContext:()=>{f.engine.execute(f.command);}}),{code:'input_stale'});
 assert.equal(f.store.list('model-call').length,0);assert.equal(f.store.get(f.scope.id)!.revision,2);
 assert.equal(f.store.get<any>(f.counter)!.value.serial,1);
});

test('a different intervening policy or invalid dispatch counter cannot be overwritten',t=>{
 const f=fixture(t);
 f.store.write({id:f.counter,kind:'project-dispatch',expected:0,value:{projectId:'other',serial:1}});
 assert.throws(()=>f.engine.execute(f.command),{code:'obligation_application_dispatch_invalid'});
 assert.equal(f.store.get(f.scope.id)!.revision,1);
 const counter=f.store.get(f.counter)!;f.store.write({id:counter.id,kind:counter.kind,expected:counter.revision,value:{projectId:'p',serial:1}});
 const different:ResearchScope={...f.scope.value,policy:{...f.policy,assignments:f.policy.assignments.map(a=>({...a,reason:'Another explicit owner policy'}))}};
 configureResearchScope(f.store,different,1);
 assert.throws(()=>f.engine.execute(f.command),{code:'obligation_application_stale'});
 assert.equal(f.store.get<ResearchScope>(f.scope.id)!.value.policy!.assignments[0]!.reason,'Another explicit owner policy');
});
