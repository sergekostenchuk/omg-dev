import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,type Write,type ReadGuard} from '../src/storage/store.js';
import {ProductEngine} from '../src/product/engine.js';
import {reference} from '../src/pipeline/contracts.js';
import {hashJson} from '../src/canonical.js';
import {dispatchMode,queueReadingPlan,retryPlannedRead,splitPlannedContextRead} from '../src/discovery/reading-plan.js';
import {readResearchContext} from '../src/discovery/research-limits.js';
import type {ReaderPilot} from '../src/discovery/reader-pilot.js';
import type {Revision} from '../src/storage/store.js';
import type {Question} from '../src/discovery/discovery.js';
import type {ResearchRun,ResearchTurn,ResearchAction} from '../src/discovery/research-model.js';

function fixture(t:test.TestContext,contextText?:string){
 const root=mkdtempSync(join(tmpdir(),'omg-plan-recovery-')),store=new Store(join(root,'db.sqlite'));
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const engine=new ProductEngine(store);engine.execute({type:'create-project',project:'p',title:'Planned read'});
 const input=contextText?store.write({id:'context',kind:'stage',expected:0,value:{projectId:'p',stage:'concept',content:{fields:{text:contextText}}}}):null;
 const draft=engine.discovery.create('p','discovery','R0','compilation',[{field:'result',kind:'design',prompt:'Read the producer',risk:'Missing producer',schema:{}}],input?[reference(input)]:[]);
 const q=store.get<Question>(draft.value.questions[0]!)!;
 const run=store.write<ResearchRun>({id:'run',kind:'research-run',expected:0,value:{projectId:'p',draftId:draft.id,environment:reference(draft),status:'paused',turns:1,limit:10,inputs:[],ownerQuestion:null,error:null,owner:{pid:process.pid,started:'fixture'},requestChars:0}});
 const action:Extract<ResearchAction,{action:'read_plan'}>={action:'read_plan',question:q.id,reads:[input?
   {action:'read_context',record:reference(input),pointer:'/content/fields/text',page:{offset:0,limit:contextText!.length}}:
   {action:'read',path:'missing.ts',media:'text/plain'}]};
 const parent=store.write<ResearchTurn>({id:'parent',kind:'research-turn',expected:0,value:{run:run.id,number:1,action,status:'pending',question:reference(q),assessment:null,observation:null,error:null,dispatchMode:'planning'}});
 const queued=queueReadingPlan(store,run,parent,draft,q,action);
 store.write({id:parent.id,kind:parent.kind,expected:parent.revision,value:{...parent.value,status:'completed'}});
 const pending=store.get<ResearchTurn>(queued.children[0]!.id)!;
 const child=store.write<ResearchTurn>({id:pending.id,kind:pending.kind,expected:pending.revision,value:{...pending.value,status:'completed',error:'Missing source',observation:{code:'source_missing'}}});
 const turns=()=>store.list<ResearchTurn>('research-turn').sort((a,b)=>a.value.number-b.value.number);
 return {store,engine,draft,q,run:queued.run,parent,child,turns,input};
}

test('a failed planned child blocks synthesis even if it is not the last turn',t=>{
 const f=fixture(t);
 assert.throws(()=>dispatchMode(f.turns(),f.q),{code:'reading_plan_blocked'});
 f.store.write<ResearchTurn>({id:'later',kind:'research-turn',expected:0,value:{...f.child.value,number:3,error:null,action:{action:'search',query:'another source'}}});
 assert.throws(()=>dispatchMode(f.turns(),f.q),{code:'reading_plan_blocked'});
 assert.equal(f.store.list('model-call').length,0);
});

test('explicit retry preserves the original action, history and budget while requeueing only its child',t=>{
 const f=fixture(t),old=f.store.get(f.child.id,f.child.revision);
 const result=f.engine.execute({type:'retry-planned-read',project:'p',child:reference(f.child)}) as ReturnType<typeof retryPlannedRead>;
 assert.equal(result.value.status,'pending');assert.equal(result.value.error,null);
 assert.deepEqual(result.value.action,f.child.value.action);assert.deepEqual(result.value.replayedFrom,reference(f.child));
 assert.deepEqual(f.store.get(f.child.id,f.child.revision),old);
 assert.equal(f.store.list('model-call').length,0);
 assert.equal(f.store.list('research-budget').length,0);
 assert.equal(dispatchMode(f.turns(),f.q),'synthesis'); // Runner must execute the pending child before dispatching this mode.
 assert.throws(()=>retryPlannedRead(f.store,'p',reference(f.child)),{code:'reading_plan_recovery_invalid'});
});

test('foreign project, changed question, running work and forged child lineage cannot be recovered',t=>{
 const f=fixture(t);
 assert.throws(()=>retryPlannedRead(f.store,'foreign',reference(f.child)),{code:'reading_plan_recovery_foreign'});
 f.store.write({id:'active',kind:'model-call',expected:0,value:{projectId:'p',questionId:f.q.id,status:'running'}});
 assert.throws(()=>retryPlannedRead(f.store,'p',reference(f.child)),{code:'reading_plan_call_active'});
 f.store.write({id:'active',kind:'model-call',expected:1,value:{projectId:'p',questionId:f.q.id,status:'failed'}});
 const forged=f.store.write<ResearchTurn>({id:f.child.id,kind:f.child.kind,expected:f.child.revision,value:{...f.child.value,action:{action:'search',query:'not in this plan'}}});
 assert.throws(()=>retryPlannedRead(f.store,'p',reference(forged)),{code:'reading_plan_recovery_foreign'});
 f.engine.discovery.reopen(f.q.id,f.q.revision);
 assert.throws(()=>retryPlannedRead(f.store,'p',reference(forged)),{code:'reading_plan_recovery_foreign'});
});

test('a concurrent question dispatch cannot race the idle check and reset a child',t=>{
 const f=fixture(t),write=f.store.writeMany.bind(f.store);
 f.store.writeMany=function<T>(writes:Write[],guards:ReadGuard[]=[]){
  f.store.writeMany=write;
  write([{id:`question-dispatch:${hashJson(f.q.id)}`,kind:'question-dispatch',expected:0,value:{projectId:'p',question:f.q.id,serial:1}}]);
  return write<T>(writes,guards);
 };
 assert.throws(()=>retryPlannedRead(f.store,'p',reference(f.child)),{code:'revision_conflict'});
 assert.deepEqual(f.store.get(f.child.id),f.child);
});

test('oversized planned context pages split to complete original coverage without buying another call',t=>{
 const text='0123456789'.repeat(600),f=fixture(t,text);
 retryPlannedRead(f.store,'p',reference(f.child));
 const pilot={value:{projectId:'p',maxReadChars:1300}} as Revision<ReaderPilot>;
 let run=f.run;
 const pieces:{offset:number;text:string}[]=[];
 for(let attempts=0;attempts<100;attempts++){
  const child=f.turns().find(t=>t.value.status==='pending');if(!child)break;
  const action=child.value.action as Extract<ResearchAction,{action:'read_context'}>;
  try{
    const result=readResearchContext(f.store,f.draft,f.q.id,pilot,action.record,action.pointer,action.page);
    pieces.push({offset:result.page!.offset,text:result.value as string});
    f.store.write<ResearchTurn>({id:child.id,kind:child.kind,expected:child.revision,value:{...child.value,status:'completed',observation:result}});
  }catch(error){
    assert.equal((error as {code:string}).code,'context_read_limit');
    const split=splitPlannedContextRead(f.store,run,child,f.draft,f.q);run=split.run;
    assert.equal(split.children.length,2);
  }
 }
 assert.equal(f.turns().filter(t=>t.value.status==='pending').length,0);
 assert.equal(pieces.sort((a,b)=>a.offset-b.offset).map(p=>p.text).join(''),text);
 assert.equal(dispatchMode(f.turns(),f.q),'synthesis');
 assert.equal(f.store.list('model-call').length,0);
 const splitChild=f.turns().find(t=>t.value.splitFrom&&t.value.observation&&!((t.value.observation as any).splitInto))!;
 const failed=f.store.write<ResearchTurn>({id:splitChild.id,kind:splitChild.kind,expected:splitChild.revision,value:{...splitChild.value,error:'temporary source problem'}});
 const retried=retryPlannedRead(f.store,'p',reference(failed));
 const failedAgain=f.store.write<ResearchTurn>({id:retried.id,kind:retried.kind,expected:retried.revision,value:{...retried.value,status:'completed',error:'still unavailable'}});
 assert.equal(retryPlannedRead(f.store,'p',reference(failedAgain)).value.status,'pending');
});

test('splitting does not hide a changed source basis',t=>{
 const f=fixture(t,'X'.repeat(4000));
 const child=retryPlannedRead(f.store,'p',reference(f.child));
 f.store.write({id:f.input!.id,kind:f.input!.kind,expected:f.input!.revision,value:{changed:true}});
 assert.throws(()=>splitPlannedContextRead(f.store,f.run,child,f.draft,f.q));
 assert.equal(f.store.get(child.id)!.revision,child.revision);
 assert.equal(f.store.list('model-call').length,0);
});
