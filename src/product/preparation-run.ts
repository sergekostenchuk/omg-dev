import type { ProductEngine } from './engine.js';
import type { DiscoveryDraft } from '../discovery/discovery.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { Feasibility } from '../graph/refinement.js';
import type { TransactionGuard } from '../storage/store.js';
import { reference, isRef, stageId, type Ref, type Finding, type StageArtifact } from '../pipeline/contracts.js';
import { processStart } from '../runtime/process-identity.js';
import { assertPilotBoundary } from '../discovery/reader-pilot.js';
import { researchScope } from '../graph/research-scope.js';
import { canonical } from '../canonical.js';
import { requireCondition, EngineError } from '../errors.js';
import { withInvocationAllowance } from '../discovery/invocation-progress.js';

interface PreparationRun {projectId:string;status:'running'|'paused'|'accepted';phase:string;draft:Ref|null;plan:Ref|null;
  owner:{pid:number;started:string};error:string|null;code:string|null;findings:Finding[];calls:number}
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
 let run=store.writeMany<PreparationRun>([{id,kind:'preparation-run',expected:previous?.revision??0,value:{projectId:project,status:'running',phase:'R2',draft:null,plan:null,owner,error:null,code:null,findings:[],calls:0}}],route.guards)[0]!;
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
 }
}
