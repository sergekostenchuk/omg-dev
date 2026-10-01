import type { ProductEngine } from './engine.js';
import type { DiscoveryDraft } from '../discovery/discovery.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { Feasibility } from '../graph/refinement.js';
import type { Store, Revision, Write, TransactionGuard } from '../storage/store.js';
import { storeView } from '../storage/store-view.js';
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
import { checkedLegacyOperation, legacyExact, legacyFailure, legacyObject, legacySame, readLegacyOperation, type LegacyOperation, type PreparationRun } from './stage-checks.js';
// R2 (№2427): the legacy operation's reader and its proof chain live in the lower kit; the producers below call it.
export { readLegacyOperation, type LegacyOperation } from './stage-checks.js';


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
 catch(error){if(error instanceof EngineError)throw new EngineError(error.code,error.message,{unit:'product',target:head.id,original:error.details??null});throw error;}
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
  // Q1: write and writeMany go through the same interception — a producer
  // switching methods cannot bypass the lock guards (№1728, C17/C18).
  const guarded=storeView(store,{write:(inputs,guards)=>store.writeMany(inputs,[...guards,reference(head),lockGuard])});
  const lock=acquire(guarded,project);
  try{await parkCandidate(store,engine.compiler,project,head.value.basis);}finally{release(store,lock);}
 }
 return releaseLegacyOperation(store,head,null,null,true);
 }catch(error){
  if(error instanceof EngineError)throw new EngineError(error.code,error.message,{unit:'product',target:`legacy-operation:${project}`,original:error.details??null});
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
