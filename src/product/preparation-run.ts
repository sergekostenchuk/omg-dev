import type { ProductEngine } from './engine.js';
import type { DiscoveryDraft } from '../discovery/discovery.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { Feasibility } from '../graph/refinement.js';
import type { Store, Revision, Write, TransactionGuard } from '../storage/store.js';
import { reference, isRef, stageId, type Ref, type Finding, type StageArtifact } from '../pipeline/contracts.js';
import { processStart } from '../runtime/process-identity.js';
import { assertPilotBoundary } from '../discovery/reader-pilot.js';
import { researchScope } from '../graph/research-scope.js';
import { canonical, hashJson } from '../canonical.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { requireIdentityGone, prepareModelCallRecovery, readModelCallRecovery } from '../discovery/model-call-recovery.js';
import { acquire, release } from '../execution/lock.js';
import { parkCandidate, type ParkedCandidate } from '../execution/park.js';
import type { ExecutionLock } from '../execution/model.js';
import { requireCondition, EngineError } from '../errors.js';
import { withInvocationAllowance } from '../discovery/invocation-progress.js';

interface PreparationRun {projectId:string;status:'running'|'paused'|'accepted';phase:string;draft:Ref|null;plan:Ref|null;
  owner:{pid:number;started:string};error:string|null;code:string|null;findings:Finding[];calls:number}

export interface LegacyOperation {
 contract:'legacy-operation/v1'; projectId:string; operation:'prepare'|'repair'; token:string;
 basis:Ref; owner:{pid:number;started:string}; state:'active'|'released'; previous:Ref|null;
 release:null|{from:Ref;reason:'returned'|'failed'|'recovered';result:Ref|null;error:{code:string;message:string}|null;
  dispatch:TransactionGuard;calls:Ref[];parking:Ref|null};
}
const legacyObject=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const legacySame=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
function legacyFailure(project:string,code:string,message:string):never{
 throw new EngineError(code,message,{unit:'product',target:`legacy-operation:${project}`});
}
function legacyExact(store:Store,project:string,ref:Ref,kind?:string):Revision<any>{
 if(!isRef(ref))legacyFailure(project,'legacy_operation_invalid','An exact operation source is required');
 const record=store.get(ref.id,ref.revision);
 if(!record||!legacyObject(record.value)||!legacySame(reference(record),ref)||hashJson(record.value)!==ref.hash||(kind&&record.kind!==kind))
  legacyFailure(project,'legacy_operation_invalid','An exact operation source is unavailable');
 return record;
}
function preparationResultShape(value:unknown):value is PreparationRun{
 return legacyObject(value)&&typeof value.projectId==='string'&&['running','paused','accepted'].includes(value.status)
  &&['R2','L3','R3','compilation'].includes(value.phase)&&(value.draft===null||isRef(value.draft))
  &&(value.plan===null||isRef(value.plan))&&legacyObject(value.owner)&&Number.isSafeInteger(value.owner.pid)&&value.owner.pid>0
  &&typeof value.owner.started==='string'&&value.owner.started.length>0&&(value.error===null||typeof value.error==='string')
  &&(value.code===null||typeof value.code==='string')&&Number.isSafeInteger(value.calls)&&value.calls>=0
  &&Array.isArray(value.findings)&&value.findings.every(item=>legacyObject(item)&&typeof item.code==='string'
   &&typeof item.target==='string'&&typeof item.message==='string'&&(item.field===undefined||typeof item.field==='string'));
}
// The release writer and historical reader use this same completion contract.
function checkedLegacyResult(store:Store,project:string,operation:LegacyOperation,proof:NonNullable<LegacyOperation['release']>):void{
 const failure=legacyObject(proof.error)&&typeof proof.error.code==='string'&&proof.error.code.length>0
  &&typeof proof.error.message==='string'&&proof.error.message.length>0;
 if(!(proof.reason==='returned'?isRef(proof.result)&&proof.error===null
  :proof.reason==='failed'?failure:proof.reason==='recovered'&&proof.result===null&&proof.error===null))
  legacyFailure(project,'legacy_operation_invalid','Release reason requires its saved result or failure');
 if(proof.result===null)return;
 const result=legacyExact(store,project,proof.result),value=result.value;
 if(operation.operation==='prepare'){
  if(result.kind!=='preparation-run'||result.id!==operation.basis.id||result.revision<=operation.basis.revision
   ||!preparationResultShape(value)||value.projectId!==project||!legacySame(value.owner,operation.owner)
   ||!['paused','accepted'].includes(value.status)
   ||(value.status==='accepted'?value.phase!=='compilation'||value.draft!==null||!isRef(value.plan)||value.error!==null||value.code!==null:value.plan!==null))
   legacyFailure(project,'legacy_operation_invalid','Release needs this preparation\'s complete terminal result');
  // A later invocation may have the same pid. Its result cannot finish this one:
  // the first terminal revision ends the preparation that began at basis.
  for(let revision=operation.basis.revision;revision<result.revision;revision++){
   const prior=store.get<PreparationRun>(result.id,revision);
   if(!prior||prior.kind!=='preparation-run'||hashJson(prior.value)!==prior.hash||!preparationResultShape(prior.value)
    ||prior.value.projectId!==project||prior.value.status!=='running'||!legacySame(prior.value.owner,operation.owner))
    legacyFailure(project,'legacy_operation_invalid','The result must end this exact preparation invocation');
  }
  if(value.draft&&legacyExact(store,project,value.draft,'discovery-draft').value.projectId!==project)
   legacyFailure(project,'legacy_operation_invalid','The preparation result has a foreign draft');
 }else{
  if(result.kind!=='plan-repair'||result.id!==`plan-repair:${hashJson(operation.basis)}`||value.projectId!==project
   ||!isRef(value.run)||!legacySame(value.run,operation.basis)||!isRef(value.defect)||!isRef(value.parked)
   ||![1,2].includes(value.level)||!['research','design','compile','reissued'].includes(value.phase)
   ||typeof value.draftId!=='string'||!value.draftId.trim()||!(value.plan===null||isRef(value.plan))
   ||!(value.error===null||typeof value.error==='string')||!legacySame(value.parked,proof.parking)
   ||(value.phase==='reissued'?!isRef(value.plan)||value.error!==null||value.level!==2:value.plan!==null))
   legacyFailure(project,'legacy_operation_invalid','Release needs this repair\'s complete saved result');
  const failed=legacyExact(store,project,operation.basis,'task-run'),defect=legacyExact(store,project,value.defect,'plan-defect');
  const parked=legacyExact(store,project,value.parked,'parked-candidate');
  if(defect.id!==`plan-defect:${hashJson(operation.basis)}`||defect.value.projectId!==project||!isRef(defect.value.run)
   ||!legacySame(defect.value.run,operation.basis)||!isRef(failed.value.plan)||!isRef(defect.value.plan)||!legacySame(defect.value.plan,failed.value.plan)
   ||!isRef(defect.value.parked)||!legacySame(defect.value.parked,value.parked)||parked.value.projectId!==project
   ||!isRef(parked.value.run)||!legacySame(parked.value.run,operation.basis)||parked.value.state!=='parked')
   legacyFailure(project,'legacy_operation_invalid','The repair result has foreign defect or parking grounds');
 }
 if(value.plan&&legacyExact(store,project,value.plan,'plan').value.projectId!==project)
  legacyFailure(project,'legacy_operation_invalid','The saved result has a foreign plan');
}
function checkedLegacyOperation(store:Store,project:string,record:Revision<LegacyOperation>):Revision<LegacyOperation>{
 const v=record.value,id=`legacy-operation:${project}`;
 if(record.id!==id||record.kind!=='legacy-operation'||!legacyObject(v)||hashJson(v)!==record.hash
  ||v.contract!=='legacy-operation/v1'||v.projectId!==project||!['prepare','repair'].includes(v.operation)
  ||typeof v.token!=='string'||!v.token.trim()||!isRef(v.basis)||!legacyObject(v.owner)
  ||!Number.isSafeInteger(v.owner.pid)||v.owner.pid<=0||typeof v.owner.started!=='string'||!v.owner.started
  ||!['active','released'].includes(v.state)||!Object.hasOwn(v,'previous')||!Object.hasOwn(v,'release'))
  legacyFailure(project,'legacy_operation_invalid','The operation marker has an invalid contract');
 const source=legacyExact(store,project,v.basis,v.operation==='prepare'?'preparation-run':'task-run');
 if(source.value?.projectId!==project||(v.operation==='prepare'
  ?source.id!==`preparation-run:${project}`||source.value.status!=='running'||!legacyObject(source.value.owner)||!legacySame(source.value.owner,v.owner)
  :source.value.state!=='needs_plan'))legacyFailure(project,'legacy_operation_invalid','The operation has a foreign starting basis');
 const active=v.state==='active'?record:legacyExact(store,project,v.release?.from as Ref,'legacy-operation') as Revision<LegacyOperation>;
 if(v.state==='released'){
  const proof=v.release;
  if(!legacyObject(proof)||!isRef(proof.from)||proof.from.id!==id||proof.from.revision!==record.revision-1
   ||active.value.state!=='active'||!legacySame({...active.value,state:'released',release:proof},v)
   ||!['returned','failed','recovered'].includes(proof.reason)||!(proof.result===null||isRef(proof.result))
   ||!(proof.parking===null||isRef(proof.parking))||!Array.isArray(proof.calls)||!proof.calls.every(isRef)
   ||!(proof.error===null||legacyObject(proof.error)&&typeof proof.error.code==='string'&&typeof proof.error.message==='string'))
   legacyFailure(project,'legacy_operation_invalid','Release must retain the exact completed ownership');
  if(!legacyObject(proof.dispatch))legacyFailure(project,'legacy_operation_invalid','Release has no dispatch boundary');
  try{uniqueTransactionGuards([proof.dispatch]);}
  catch{legacyFailure(project,'legacy_operation_invalid','Release has an invalid dispatch boundary');}
  if(proof.dispatch.id!==`project-dispatch:${hashJson(project)}`
   ||new Set(proof.calls.map(ref=>ref.id)).size!==proof.calls.length)
   legacyFailure(project,'legacy_operation_invalid','Release must retain its dispatch boundary and complete call identities');
  if(!('absent' in proof.dispatch))legacyExact(store,project,proof.dispatch,'project-dispatch');
  for(const ref of proof.calls){const call=legacyExact(store,project,ref,'model-call');
   if(call.value.projectId!==project||!['succeeded','failed'].includes(call.value.status)||!Number.isFinite(call.value.finishedAt))
    legacyFailure(project,'legacy_operation_invalid','A released operation cannot retain unfinished calls');
   if(call.value.error==='process_lost'&&call.value.execution)readModelCallRecovery(store,project,ref);
  }
  checkedLegacyResult(store,project,v,proof);
  if(proof.parking){const parked=legacyExact(store,project,proof.parking,'parked-candidate');
   if(v.operation!=='repair'||parked.value.projectId!==project||parked.value.state!=='parked'||!isRef(parked.value.run)||!legacySame(parked.value.run,v.basis))
    legacyFailure(project,'legacy_operation_invalid','Release has a foreign parking result');
  }
 }
 if(active.value.release!==null||active.value.state!=='active')legacyFailure(project,'legacy_operation_invalid','Ownership must begin active');
 if(active.revision===1){if(active.value.previous!==null)legacyFailure(project,'legacy_operation_invalid','Initial ownership has no predecessor');}
 else{
  if(!isRef(active.value.previous)||active.value.previous.id!==id||active.value.previous.revision!==active.revision-1)
   legacyFailure(project,'legacy_operation_invalid','Ownership must follow its exact released predecessor');
  const prior=legacyExact(store,project,active.value.previous,'legacy-operation') as Revision<LegacyOperation>;
  if(prior.value.state!=='released'||prior.value.token===v.token)legacyFailure(project,'legacy_operation_invalid','Ownership cannot replace active or reuse its token');
  checkedLegacyOperation(store,project,prior);
 }
 return record;
}
export function readLegacyOperation(store:Store,project:string):Revision<LegacyOperation>|null{
 if(!store||typeof store.get!=='function'||typeof project!=='string'||!project.trim())
  throw new EngineError('legacy_operation_invalid','A project and Store are required');
 const record=store.get<LegacyOperation>(`legacy-operation:${project}`);
 return record?checkedLegacyOperation(store,project,record):null;
}
export function beginLegacyOperation(store:Store,project:string,operation:'prepare'|'repair',basis:Ref,
 writes:Write[]=[],guards:TransactionGuard[]=[]):Revision<LegacyOperation>{
 if(!['prepare','repair'].includes(operation)||!isRef(basis)||!Array.isArray(writes)||!Array.isArray(guards)
  ||!writes.every(write=>legacyObject(write)&&typeof write.id==='string'&&typeof write.kind==='string'
   &&Number.isSafeInteger(write.expected)&&write.expected>=0&&Object.hasOwn(write,'value')))
  legacyFailure(project,'legacy_operation_invalid','Complete ownership arguments are required');
 const prior=readLegacyOperation(store,project);
 if(prior?.value.state==='active')legacyFailure(project,'legacy_operation_active','A legacy operation already owns this project');
 const owner={pid:process.pid,started:processStart(process.pid)};
 if(!owner.started)legacyFailure(project,'legacy_operation_invalid','The operation needs an identifiable owner');
 const pending=writes.find(write=>write.id===basis.id&&write.expected+1===basis.revision&&hashJson(write.value)===basis.hash);
 const source=pending?{kind:pending.kind,value:pending.value as any}:legacyExact(store,project,basis);
 if(source.kind!==(operation==='prepare'?'preparation-run':'task-run')||source.value?.projectId!==project
  ||(operation==='prepare'&&basis.id!==`preparation-run:${project}`)
  ||(operation==='prepare'?!legacyObject(source.value.owner)||!legacySame(source.value.owner,owner)||source.value.status!=='running':source.value.state!=='needs_plan'))
  legacyFailure(project,'legacy_operation_invalid','The ownership basis must be this exact operation');
 const value:LegacyOperation={contract:'legacy-operation/v1',projectId:project,operation,token:randomUUID(),basis,owner,
  state:'active',previous:prior?reference(prior):null,release:null};
 return store.writeMany<LegacyOperation>([{id:`legacy-operation:${project}`,kind:'legacy-operation',expected:prior?.revision??0,value},...writes],
  uniqueTransactionGuards([{id:`om-input:${project}`,absent:true},...(prior?[reference(prior)]:[]),...(!pending?[basis]:[]),...guards]))[0]!;
}
function ownedLegacyOperation(store:Store,lease:Revision<LegacyOperation>):Revision<LegacyOperation>{
 if(!isRef(lease)||!legacyObject(lease.value)||typeof lease.value.projectId!=='string')
  throw new EngineError('legacy_operation_invalid','The exact ownership record is required');
 const project=lease.value.projectId,head=readLegacyOperation(store,project);
 if(!head||head.value.state!=='active'||!legacySame(reference(head),reference(lease))||head.value.token!==lease.value.token)
  legacyFailure(project,'legacy_operation_stale','Ownership changed; a delayed completion cannot release its successor');
 return head;
}
function physicalLegacyState(store:Store,lease:Revision<LegacyOperation>){
 const project=lease.value.projectId,id=`project-dispatch:${hashJson(project)}`,counter=store.get<{projectId:string;serial:number}>(id);
 if(counter&&(counter.kind!=='project-dispatch'||!legacyObject(counter.value)||counter.value.projectId!==project||!Number.isSafeInteger(counter.value.serial)||counter.value.serial<0))
  legacyFailure(project,'legacy_operation_invalid','The project dispatch boundary is invalid');
 const dispatch:TransactionGuard=counter?reference(counter):{id,absent:true};
 const listed=store.list<ModelCall>('model-call');
 if(listed.some(call=>!legacyObject(call.value)||typeof call.value.projectId!=='string'))
  legacyFailure(project,'legacy_operation_invalid','Project calls cannot be enumerated from incomplete identities');
 const calls=listed.filter(call=>call.value.projectId===project);
 if(calls.some(call=>!['running','succeeded','failed'].includes(call.value.status)))
  legacyFailure(project,'legacy_operation_pending','The physical outcome of a project call is unknown');
 const parking=lease.value.operation==='repair'?store.get<ParkedCandidate>(`parked:${hashJson(lease.value.basis)}`):null;
 if(parking&&(parking.kind!=='parked-candidate'||!legacyObject(parking.value)||parking.value.projectId!==project
  ||!isRef(parking.value.run)||!isRef(parking.value.root)||!legacyObject(parking.value.previous)||!legacyObject(parking.value.next)
  ||typeof parking.value.tree!=='string'||!parking.value.tree||typeof parking.value.archiveRef!=='string'||!parking.value.archiveRef
  ||!legacySame(parking.value.run,lease.value.basis)
  ||!['preparing','parked'].includes(parking.value.state)))legacyFailure(project,'legacy_operation_invalid','The parking intent is foreign');
 const parkingGuard:TransactionGuard|null=lease.value.operation==='repair'
  ?parking?reference(parking):{id:`parked:${hashJson(lease.value.basis)}`,absent:true}:null;
 return{dispatch,calls,parking,parkingGuard};
}
function releaseLegacyOperation(store:Store,lease:Revision<LegacyOperation>,result:Ref|null,error:unknown,recovered:boolean):Revision<LegacyOperation>{
 const head=ownedLegacyOperation(store,lease),project=head.value.projectId;
 const state=physicalLegacyState(store,head);
 if(state.calls.some(call=>call.value.status==='running'||!Number.isFinite(call.value.finishedAt))||state.parking?.value.state==='preparing')
  legacyFailure(project,'legacy_operation_pending','Unfinished project calls or parking retain ownership');
 for(const call of state.calls)if(call.value.error==='process_lost'&&call.value.execution)readModelCallRecovery(store,project,reference(call));
 const failure=error===null?null:{code:error instanceof EngineError?error.code:'legacy_operation_failed',message:error instanceof Error?error.message:String(error)};
 const proof:NonNullable<LegacyOperation['release']>={from:reference(head),reason:recovered?'recovered':failure?'failed':'returned',result,error:failure,
  dispatch:state.dispatch,calls:state.calls.map(reference).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),parking:state.parking?reference(state.parking):null};
 const value:LegacyOperation={...head.value,state:'released',release:proof};
 checkedLegacyOperation(store,project,{id:head.id,kind:head.kind,revision:head.revision+1,hash:hashJson(value),value});
 return store.writeMany<LegacyOperation>([{id:head.id,kind:head.kind,expected:head.revision,value}],
  uniqueTransactionGuards([reference(head),state.dispatch,...proof.calls,...(state.parkingGuard?[state.parkingGuard]:[]),...(result?[result]:[])]))[0]!;
}
export function finishLegacyOperation(store:Store,lease:Revision<LegacyOperation>,result:Ref|null,error:unknown=null):Revision<LegacyOperation>{
 const head=ownedLegacyOperation(store,lease);
 if(head.value.owner.pid!==process.pid||head.value.owner.started!==processStart(process.pid))
  legacyFailure(head.value.projectId,'legacy_operation_stale','Only this live owner can finish its operation');
 return releaseLegacyOperation(store,head,result,error,false);
}
export async function recoverLegacyOperation(engine:ProductEngine,request:{project:string;operation:Ref;token:string}):Promise<Revision<LegacyOperation>>{
 if(!engine||!engine.store||typeof engine.store.get!=='function'||!legacyObject(request)||typeof request.project!=='string'||!isRef(request.operation)||typeof request.token!=='string'||!request.token.trim())
  throw new EngineError('legacy_operation_invalid','Recovery needs the exact ownership revision and token');
 const {store}=engine,project=request.project;
 try{
 const source=legacyExact(store,project,request.operation,'legacy-operation') as Revision<LegacyOperation>;
 checkedLegacyOperation(store,project,source);
 if(source.value.token!==request.token)legacyFailure(project,'legacy_operation_stale','The ownership token does not match');
 const completed=store.get<LegacyOperation>(source.id,source.revision+1);
 if(completed){
  const next=checkedLegacyOperation(store,project,completed);
  if(next.value.state==='released'&&legacySame(next.value.release!.from,request.operation))return next;
 }
 const head=ownedLegacyOperation(store,source);
 try{requireIdentityGone(head.value.owner,'The legacy operation owner is still alive');}
 catch(error){if(error instanceof EngineError)throw new EngineError(error.code,error.message,{unit:'product',target:head.id});throw error;}
 const state=physicalLegacyState(store,head),recoveries=state.calls.filter(call=>call.value.status==='running').map(call=>{
  if(call.value.execution?.version!=='model-execution/v1')legacyFailure(project,'legacy_operation_pending','A call without physical identity cannot be released');
  return prepareModelCallRecovery(store,project,reference(call));
 });
 if(recoveries.length)store.writeMany(recoveries.flatMap(item=>item.writes),uniqueTransactionGuards([reference(head),state.dispatch,...recoveries.flatMap(item=>item.guards)]));
 if(state.parking?.value.state==='preparing'){
  const parked=state.parking,root=legacyExact(store,project,parked.value.root,'execution-root');
  const key=hashJson([store.databaseId,head.value.basis]).slice(0,24);
  const next={...root.value,path:join(dirname(store.path),'worktrees',key),branch:`omg/${key}`,base:root.value.head,head:root.value.head,state:'ready'};
  if(!legacySame(parked.value.previous,root.value)||!legacySame(parked.value.next,next)||parked.value.archiveRef!==`refs/omg/candidates/${key}`)
   legacyFailure(project,'legacy_operation_invalid','The saved parking destination does not follow its exact intent');
  const lockId=`execution-lock:${project}`,currentLock=store.get<ExecutionLock>(lockId);
  if(currentLock&&(currentLock.kind!=='execution-lock'||!legacyObject(currentLock.value)||currentLock.value.projectId!==project
   ||typeof currentLock.value.active!=='boolean'||typeof currentLock.value.token!=='string'||!currentLock.value.token
   ||!Number.isSafeInteger(currentLock.value.pid)||currentLock.value.pid<=0
   ||typeof currentLock.value.processStart!=='string'||!currentLock.value.processStart))
   legacyFailure(project,'legacy_operation_invalid','Parking recovery requires an exact executor identity');
  if(currentLock?.value.active)requireIdentityGone({pid:currentLock.value.pid,started:currentLock.value.processStart},'The parking executor is still alive');
  const lockGuard:TransactionGuard=currentLock?reference(currentLock):{id:lockId,absent:true};
  // The common acquire must commit against the identity observed above, even if its own read sees a later lock.
  const guarded=new Proxy(store,{get(target,key){
   if(key==='write')return <T>(write:Write)=>target.writeMany<T>([write],[reference(head),lockGuard])[0]!;
   const member=Reflect.get(target,key,target);return typeof member==='function'?member.bind(target):member;
  }});
  const lock=acquire(guarded,project);
  try{await parkCandidate(store,engine.compiler,project,head.value.basis);}finally{release(store,lock);}
 }
 return releaseLegacyOperation(store,head,null,null,true);
 }catch(error){
  if(error instanceof EngineError)throw new EngineError(error.code,error.message,{unit:'product',target:`legacy-operation:${project}`});
  throw error;
 }
}

/** The product owns the whole transition to an accepted plan. Existence is not
 * acceptance; a failed/stale predecessor can never be silently skipped. */
export async function continuePreparation(engine:ProductEngine,project:string,maxCalls:number){
 const {store,refinement,pipeline}=engine;
 requireCondition(Number.isSafeInteger(maxCalls)&&maxCalls>0&&maxCalls<=100,'research_budget_invalid','Use a bounded invocation allowance');
 const route=engine.legacyRoute(project);
 if(!route.om)assertPilotBoundary(store,project,'R3');
 const id=`preparation-run:${project}`,previous=store.get<PreparationRun>(id);
 if(route.om){
  if(previous?.kind==='preparation-run'&&previous.value?.projectId===project&&previous.value.status==='accepted'&&isRef(previous.value.plan)){
   const plan=engine.compiler.read(previous.value.plan.id);
   const accepted=store.history<StageArtifact>(stageId(project,'compilation')).some(stage=>stage.kind==='stage'
    &&stage.value?.projectId===project&&stage.value.stage==='compilation'&&stage.value.status==='accepted'
    &&canonical(stage.value.content??null)===canonical({plan:previous.value.plan})
    &&Array.isArray(stage.value.inputs)&&stage.value.inputs.length===1&&canonical(stage.value.inputs[0])===canonical(plan.value.stage)
    &&Array.isArray(stage.value.proofs)&&stage.value.proofs.some(ref=>canonical(ref)===canonical(previous.value.plan)));
   if(plan.value.projectId===project&&canonical(reference(plan))===canonical(previous.value.plan)&&accepted)return previous;
  }
  throw new EngineError('legacy_route_closed','OM projects cannot continue legacy preparation',{unit:'product',target:`om-input:${project}`});
 }
 requireCondition(!previous||(previous.kind==='preparation-run'&&previous.value.projectId===project
   &&Number.isSafeInteger(previous.value.owner?.pid)&&typeof previous.value.owner?.started==='string'&&previous.value.owner.started.length>0),
   'preparation_identity_missing','Existing preparation needs a verifiable owner identity');
 requireCondition(previous?.value.status!=='running'||processStart(previous.value.owner.pid)!==previous.value.owner.started,
   'preparation_busy','This project already has a preparation process');
 const owner={pid:process.pid,started:processStart(process.pid)};
 requireCondition(owner.started,'research_process_unknown','Preparation needs an identifiable owner');
 const count=()=>store.list<ModelCall>('model-call').filter(c=>c.value.projectId===project).length;
 const before=count();
 const initial:Write={id,kind:'preparation-run',expected:previous?.revision??0,value:{projectId:project,status:'running',phase:'R2',draft:null,plan:null,owner,error:null,code:null,findings:[],calls:0}};
 const basis={id,revision:initial.expected+1,hash:hashJson(initial.value)};
 const lease=beginLegacyOperation(store,project,'prepare',basis,[initial],route.guards);
 let run=store.get<PreparationRun>(id)!;
 const save=(patch:Partial<PreparationRun>,guards:TransactionGuard[]=[])=>run=store.writeMany<PreparationRun>([{id,kind:run.kind,expected:run.revision,value:{...run.value,...patch,calls:count()-before}}],guards)[0]!;
 try{return await withInvocationAllowance(maxCalls,async()=>{
  for(const phase of ['R2','L3'] as const){
   save({phase});
   const existing=store.get(`phase:${project}:${phase}`);
   if(existing){const gate=refinement.gate(project,phase);if(gate.findings.length)throw new EngineError('phase_not_ready',`Existing ${phase} is stale`,gate.findings);continue;}
   const scope=researchScope(store,project);
   const candidates=store.list<DiscoveryDraft>('discovery-draft').filter(d=>d.value.projectId===project&&d.value.stage==='om-g2'&&d.value.level==='R2'
    &&(phase==='R2'?d.value.consumer==='compilation':d.value.consumer!=='compilation')
    &&(!scope||d.value.inputs.some(ref=>canonical(ref)===canonical(reference(scope))))).sort((a,b)=>b.value.createdAt-a.value.createdAt);
   const draft=candidates[0]??(phase==='R2'?refinement.begin(project,'R2'):refinement.prepareLayer(project,3));
   save({draft:reference(draft)});
   const result=await engine.refinementResearch.run(project,phase,draft.id,100);
   if(result.status!=='accepted'){
    const research=result.research?store.get<{pauseCode?:string;error:string|null}>(result.research.id):null;
    save({status:'paused',code:research?.value.pauseCode??result.status,error:research?.value.error??'Research has not been accepted',findings:result.findings});
    return run;
   }
  }
  save({phase:'R3',draft:null});
  let feasibility=store.get<Feasibility>(`feasibility:${project}`);
  if(!feasibility||refinement.feasibilityGate(project,reference(feasibility)).findings.length)
    feasibility=refinement.assess(project,feasibility?.revision??0,route.guards);
  if(!feasibility.value.ready)throw new EngineError('feasibility_not_ready','R3 has unresolved feasibility findings',feasibility.value.findings);
  const om=pipeline.inspect(project,'om-g2');
  if(om.state!=='accepted'){
    requireCondition(om.artifact?.value.status!=='accepted','phase_not_ready','Accepted OM-G2 changed; reconcile its basis before publishing');
    const artifact=refinement.publish(project,reference(feasibility),om.artifact?.revision??0,route.guards);
    pipeline.accept(project,'om-g2',artifact.revision,route.guards);
  }
  save({phase:'compilation'});
  const plan=engine.compile(project,route.guards);
  const accepted=pipeline.inspect(project,'compilation');
  requireCondition(accepted.state==='accepted'&&canonical((accepted.artifact!.value.content as unknown as {plan:Ref}).plan)===canonical(reference(plan)),
    'plan_not_accepted','Compilation must end at the accepted exact machine plan');
  save({status:'accepted',plan:reference(plan),error:null,code:null},route.guards);
  return run;
 });}catch(error){
  save({status:'paused',error:error instanceof Error?error.message:'Preparation failed',code:error instanceof EngineError?error.code:'preparation_failed',
    findings:error instanceof EngineError&&Array.isArray(error.details)?error.details as Finding[]:[]});
  return run;
 }finally{finishLegacyOperation(store,lease,reference(run));}
}
