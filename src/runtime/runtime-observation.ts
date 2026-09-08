import { createHash } from 'node:crypto';
import { createReadStream, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { relative, join, dirname, isAbsolute } from 'node:path';
import { platform, release, arch, tmpdir } from 'node:os';
import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { Evidence, type Observation, type Source } from '../evidence/evidence.js';
import { isRef, reference, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import type { Store, Revision } from '../storage/store.js';
import { researchScope } from '../graph/research-scope.js';
import { obligationAssignment, type RuntimeCheck } from '../graph/obligation-policy.js';
import { Environments, workspacePath, executablePath } from './environment.js';
import { readerPilot } from '../discovery/reader-pilot.js';
import { processStart } from './process-identity.js';
import { runProcess, type ProcessResult } from './process.js';
import type { ModelCall } from './model-usage.js';
import { runtimeSource, type RuntimeObservation } from './runtime-observation-model.js';

export interface RuntimeObservationRequest { scope: Ref; obligation: string; key: string }
export interface RuntimeObservationResult { observation: Revision<RuntimeObservation>; source: Revision<Source> | null }

export function runtimeContext(store: Store, project: string) {
  const effective = new Environments(store).effective(project), pilot = readerPilot(store,project);
  const configured = store.get(`reader-pilot:${project}`);
  const binding = { environment:effective.environment.value,root:effective.root,
    identity:{uid:process.getuid?.()??null,gid:process.getgid?.()??null,euid:process.geteuid?.()??null,egid:process.getegid?.()??null,groups:process.getgroups?.().sort((a,b)=>a-b)??[]},
    // PATH is checked through resolved declared executables: an irrelevant
    // prefix must not invalidate evidence. Do not publish arbitrary env/secrets.
    processEnvironment:Object.fromEntries(['HOME','USERPROFILE','SystemRoot','WINDIR','TMPDIR','TEMP','TMP','LANG','LC_ALL'].map(key=>[key,process.env[key]??null])),
    pilot:pilot ? {reader:pilot.value.reader,agentCommand:pilot.value.agentCommand,callTimeoutMs:pilot.value.callTimeoutMs??null} : null,
    platform:{os:platform(),release:release(),arch:arch(),node:process.version} };
  return { ...effective,binding:binding as unknown as Json,
    guards:uniqueRefs([reference(effective.environment),...effective.guards,...(configured?[reference(configured)]:[])]) };
}

export function runtimeCode(store: Store, project: string, check: RuntimeCheck, root: string | null): Observation[] {
  const evidence = new Evidence(store);
  return uniqueRefs([check.script,...check.dependencies]).map(ref => {
    const source = store.get<Source>(ref.id);
    requireCondition(source?.kind==='source' && source.value.projectId===project
      && ['text/plain','application/json'].includes(source.value.mediaType) && source.value.content.trim()
      && canonical(reference(source))===canonical(ref),'runtime_check_source_invalid','The declared check code is missing, foreign or changed');
    if(root===null)requireCondition(source.value.origin.kind==='owner-document'&&!source.value.provenance
      &&source.value.mediaType==='text/plain'&&canonical(ref)===canonical(check.script)&&check.dependencies.length===0,
    'runtime_check_source_invalid','An operator module is explicit immutable code, not a repository fact or runtime output');
    else requireCondition(source.value.origin.kind==='file'&&realpathSync(workspacePath(root,relative(root,source.value.origin.location)))===source.value.origin.location,
        'runtime_check_source_invalid','The check must execute the declared source inside the selected workspace');
    return evidence.observe(project,ref,{kind:'text-range',start:0,end:source.value.content.length});
  });
}

function checkCodeRoot(store:Store,project:string,check:RuntimeCheck,current:ReturnType<typeof runtimeContext>):string|null{
  const script=store.get<Source>(check.script.id);
  if(script?.kind==='source'&&script.value.projectId===project&&script.value.origin.kind==='owner-document')return null;
  requireCondition(script?.kind==='source'&&script.value.projectId===project&&script.value.origin.kind==='file'
    &&script.value.origin.location.endsWith('.mjs'),'runtime_check_source_invalid','Declare a versioned Node .mjs check, not an inferred interpreter or module mode');
  for(const root of [current.root,current.environment.value.workspace]){
    try{workspacePath(root,relative(root,script.value.origin.location));return root;}catch{/* Try the declared source workspace. */}
  }
  throw new EngineError('runtime_check_source_invalid','Check code must belong to the selected source or managed execution workspace');
}

async function executableHash(path: string): Promise<string> {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function runtimeExecutableIdentity(path:string){
  const stat=statSync(path);requireCondition(stat.isFile(),'runtime_subject_invalid','Runtime subjects must be regular files');
  const {dev,ino,size,mtimeMs,ctimeMs}=stat;return {dev,ino,size,mtimeMs,ctimeMs};
}
export function runtimeSubjectPath(root:string,declared:string,kind:'file'|'executable'='file'):string{
  // Absolute runtime binaries may live outside the repository; only the exact
  // owner-declared path is read, and only its fingerprint is published.
  try{return kind==='executable'?executablePath({executable:declared,args:[]},root):realpathSync(isAbsolute(declared)?declared:workspacePath(root,declared));}
  catch{throw new EngineError('runtime_subject_invalid','A declared runtime subject is unavailable or has an invalid relative path');}
}
function recordedResult(store: Store, observation: Revision<RuntimeObservation>): RuntimeObservationResult {
  requireCondition(observation.value.version===1,'runtime_observation_version_unsupported','This runtime observation format is unsupported');
  if(observation.value.status!=='observed') return {observation,source:null};
  const expected=runtimeSource(observation),source=store.get<Source>(expected.id);
  requireCondition(source?.kind==='source' && canonical(source.value)===canonical(expected.value),
    'runtime_observation_source_changed','The saved runtime source is missing or changed; no check was silently repeated');
  return {observation,source};
}

/** Only an explicit operator command executes the source declared in owner
 * policy. ResearchAction remains read-only and cannot invent an executable. */
export async function observeRuntime(store: Store, project: string, request: RuntimeObservationRequest, signal?: AbortSignal): Promise<RuntimeObservationResult> {
  requireCondition(request && isRef(request.scope) && request.scope.id===`research-scope:${project}:R2`
    && typeof request.obligation==='string' && request.obligation.trim() && typeof request.key==='string' && request.key.trim(),
  'runtime_observation_invalid','An observation needs its exact scope, obligation and stable operation key');
  const id=`runtime-observation:${hashJson([project,request.key])}`,old=store.get<RuntimeObservation>(id);
  if(old){
    requireCondition(old.kind==='runtime-observation' && old.value.projectId===project && old.value.key===request.key
      && canonical(old.value.scope)===canonical(request.scope) && old.value.requestedFor===request.obligation,
    'runtime_observation_conflict','The operation key already belongs to another observation');
    return recordedResult(store,old);
  }
  const scope=researchScope(store,project);
  requireCondition(scope && canonical(reference(scope))===canonical(request.scope),'runtime_observation_scope_stale','Observe the exact current scope');
  const assignment=obligationAssignment(scope.value,request.obligation);
  requireCondition(assignment?.kind==='environment-confirmation' && assignment.runtimeCheck,
    'runtime_check_not_declared','The owner policy must declare the check; the model cannot select a program');
  const check=assignment.runtimeCheck,current=runtimeContext(store,project),codeRoot=checkCodeRoot(store,project,check,current),code=runtimeCode(store,project,check,codeRoot);
  const executablePath=realpathSync(process.execPath),identity=runtimeExecutableIdentity(executablePath);
  const executable={path:executablePath,hash:await executableHash(executablePath),identity};
  requireCondition(canonical(identity)===canonical(runtimeExecutableIdentity(executablePath)),
    'runtime_observation_stale','The runtime executable changed while its identity was captured');
  const subjects:RuntimeObservation['subjects']=[];
  const requestedSubjects=[...check.subjects.map(requested=>({requested,kind:'file' as const})),...check.executables.map(requested=>({requested,kind:'executable' as const}))];
  for(const {requested,kind} of requestedSubjects){
    const path=runtimeSubjectPath(current.root,requested,kind);
    const identity=runtimeExecutableIdentity(path),hash=path===executable.path?executable.hash:await executableHash(path);
    requireCondition(canonical(identity)===canonical(runtimeExecutableIdentity(path)),'runtime_observation_stale','A runtime subject changed during capture');
    subjects.push({requested,kind,path,hash,identity});
  }
  const owner={pid:process.pid,started:processStart(process.pid)};
  requireCondition(owner.started,'runtime_observation_identity_missing','The observer process must have an exact identity');
  const counterId=`project-dispatch:${hashJson(project)}`,counter=store.get<{projectId:string;serial:number}>(counterId);
  requireCondition(!counter || (counter.kind==='project-dispatch' && counter.value.projectId===project
    && Number.isSafeInteger(counter.value.serial) && counter.value.serial>=0 && counter.value.serial<Number.MAX_SAFE_INTEGER),
  'runtime_observation_dispatch_invalid','The project dispatch counter is invalid');
  requireCondition(!store.list<ModelCall>('model-call').some(c=>c.value.projectId===project&&c.value.status==='running')
    && !store.list<RuntimeObservation>('runtime-observation').some(c=>c.value.projectId===project&&c.value.status==='running'),
  'runtime_observation_busy','Finish or recover the active project invocation before observing the runtime');
  const guards=uniqueRefs([reference(scope),...current.guards,...code.map(o=>o.source)]);
  let record:Revision<RuntimeObservation>;
  try {
    record=store.writeMany<RuntimeObservation>([{id,kind:'runtime-observation',expected:0,value:{version:1,projectId:project,key:request.key,
      scope:reference(scope),requestedFor:request.obligation,check,environment:reference(current.environment),context:guards,root:current.root,codeRoot,
      runtimeBinding:current.binding,platform:{os:platform(),release:release(),arch:arch(),node:process.version},executable,subjects,
      snapshot:null,invocation:null,owner:{pid:owner.pid,started:owner.started},child:null,startedAt:Date.now(),finishedAt:null,status:'running',result:null,error:null} satisfies RuntimeObservation},
      {id:counterId,kind:'project-dispatch',expected:counter?.revision??0,value:{projectId:project,serial:(counter?.value.serial??0)+1}}],guards)[0]!;
  } catch(error) {
    if(error instanceof EngineError&&['revision_conflict','input_stale'].includes(error.code)){
      const concurrent=store.get<RuntimeObservation>(id);
      if(concurrent&&concurrent.value.projectId===project&&canonical(concurrent.value.scope)===canonical(request.scope)
        &&concurrent.value.requestedFor===request.obligation)return recordedResult(store,concurrent);
    }
    throw error;
  }
  let result:ProcessResult|null=null;
  let snapshot:string|null=null;
  try {
    const script=store.get<Source>(check.script.id,check.script.revision)!;
    snapshot=mkdtempSync(join(tmpdir(),'omg-runtime-check-'));
    for(const observation of code){
      const original=store.get<Source>(observation.source.id,observation.source.revision)!;
      const target=join(snapshot,codeRoot===null?'check.mjs':relative(codeRoot,original.value.origin.location));
      mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,String(observation.value),{mode:0o400,flag:'wx'});
    }
    const invocation={executable:executable.path,args:[join(snapshot,codeRoot===null?'check.mjs':relative(codeRoot,script.value.origin.location)),...check.args]};
    record=store.write<RuntimeObservation>({id:record.id,kind:record.kind,expected:record.revision,value:{...record.value,snapshot,invocation}});
    result=await runProcess(invocation,current.root,
      canonical({protocol:'omg-runtime-observation/v1',scope:reference(scope),obligation:assignment.original,runtime:current.binding}),check.timeoutMs,signal,true,pid=>{
        const started=processStart(pid);
        if(!started){
          try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
          throw new EngineError('runtime_observation_identity_missing','A live check child must have an exact identity');
        }
        record=store.write<RuntimeObservation>({id:record.id,kind:record.kind,expected:record.revision,value:{...record.value,child:{pid,started}}});
      });
    requireCondition(result.signal===null && result.exitCode!==null,'runtime_observation_interrupted','A terminated check is not a completed runtime observation');
    const after=runtimeContext(store,project);runtimeCode(store,project,check,codeRoot);
    requireCondition(canonical(after.binding)===canonical(current.binding) && await executableHash(executable.path)===executable.hash
      && canonical(runtimeExecutableIdentity(executable.path))===canonical(executable.identity),
      'runtime_observation_stale','The runtime or check code changed during observation');
    for(const subject of subjects)requireCondition(runtimeSubjectPath(after.root,subject.requested,subject.kind)===subject.path
      &&canonical(runtimeExecutableIdentity(subject.path))===canonical(subject.identity)&&await executableHash(subject.path)===subject.hash,
    'runtime_observation_stale','A declared runtime subject changed during observation');
    const value:RuntimeObservation={...record.value,finishedAt:Date.now(),child:null,status:'observed',result,error:null};
    const completed={id:record.id,kind:record.kind,revision:record.revision+1,hash:hashJson(value),value};
    const source=runtimeSource(completed);
    const saved=store.writeMany<RuntimeObservation|Source>([{id:record.id,kind:record.kind,expected:record.revision,value},
      {id:source.id,kind:'source',expected:0,value:source.value}],uniqueRefs([reference(record),reference(scope),...after.guards,...code.map(o=>o.source)]));
    return {observation:saved[0]! as Revision<RuntimeObservation>,source:saved[1]! as Revision<Source>};
  } catch(error) {
    const code=error instanceof EngineError?error.code:'runtime_observation_failed';
    record=store.write<RuntimeObservation>({id:record.id,kind:record.kind,expected:record.revision,value:{...record.value,
      status:['input_stale','revision_conflict','runtime_check_source_invalid','source_stale','runtime_observation_stale'].includes(code)?'stale':'failed',
      child:null,finishedAt:Date.now(),result,error:`${code}: ${error instanceof Error?error.message:'Check failed'}`}});
    return {observation:record,source:null};
  } finally {if(snapshot)rmSync(snapshot,{recursive:true,force:true});}
}

export function recoverRuntimeObservation(store:Store,project:string,ref:Ref):Revision<RuntimeObservation>{
  requireCondition(isRef(ref),'runtime_observation_invalid','Recovery needs an exact observation');
  const record=store.get<RuntimeObservation>(ref.id);
  requireCondition(record?.kind==='runtime-observation'&&record.value.projectId===project&&canonical(reference(record))===canonical(ref),
    'runtime_observation_stale','Recover the exact observation of this project');
  requireCondition(['running','observed','failed','stale'].includes(record.value.status),'runtime_observation_invalid','Recovery cannot infer a missing observation state');
  if(record.value.status!=='running')return record;
  requireCondition(record.value.version===1&&record.value.owner&&Number.isSafeInteger(record.value.owner.pid)&&record.value.owner.pid>0
    &&typeof record.value.owner.started==='string'&&record.value.owner.started.length>0
    &&(record.value.child===null||record.value.child&&Number.isSafeInteger(record.value.child.pid)&&record.value.child.pid>0
      &&typeof record.value.child.started==='string'&&record.value.child.started.length>0),
  'runtime_observation_identity_missing','Recovery cannot guess a missing process identity');
  requireCondition(processStart(record.value.owner.pid)!==record.value.owner.started,
    'runtime_observation_busy','The observer is still alive; do not interrupt its work');
  const child=record.value.child;
  if(child&&processStart(child.pid)===child.started){
    requireCondition(process.platform!=='win32','runtime_recovery_unsupported','Process-group recovery requires the supported POSIX runtime');
    try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  }
  return store.write<RuntimeObservation>({id:record.id,kind:record.kind,expected:record.revision,
    value:{...record.value,status:'failed',child:null,finishedAt:Date.now(),error:'runtime_observation_interrupted: observer process ended; use a new operation key for an explicit retry'}});
}
