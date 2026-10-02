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
import { obligationAssignment, type RuntimeCheck, type CarriedObligation } from '../graph/obligation-policy.js';
import { Environments, workspacePath, executablePath, uniqueTransactionGuards } from './environment.js';
import { readerPilot } from '../discovery/reader-pilot.js';
import { processStart } from './process-identity.js';
import { runProcess, type ProcessResult } from './process.js';
import { probeProcessIdentity, stopOwnedGroup, processStopRefusal, writeProcessStopWitness,
  evaluateProcessStopWitnesses, type ProcessStopHooks, type ProcessStopReport } from './process-identity.js';
import type { ModelCall } from './model-usage.js';
import { runtimeSource, type RuntimeObservation } from './runtime-observation-model.js';
import { readOmObligationLedger } from '../graph/om-obligation-readers.js';
import { taskBindingId } from '../graph/task-obligations.js';

export interface RuntimeObservationRequest { scope: Ref; obligation: string; key: string }
export interface RuntimeObservationResult { observation: Revision<RuntimeObservation>; source: Revision<Source> | null }

/** The OM declaration is the complete proved D7 handoff, not a model's check
 * field. Historical consumers retain that exact authority after its heads move.
 * New observation admission guards the producer and its mandatory ledger. */
function omRuntimeDeclaration(store: Store, project: string, scope: Ref, current = false) {
  requireCondition(isRef(scope) && scope.id.startsWith(`om-obligations:${project}:`),
    'runtime_check_not_declared', 'An OM runtime check needs the exact obligation ledger of this project');
  const found = readOmObligationLedger(store, { project, ledger: scope });
  if (!found.ok) throw new EngineError('runtime_check_not_declared',
    'The OM runtime declaration must be derived from its exact owner authority and complete sources', found.refusal);
  const guards = [reference(found.value.producer), reference(found.value.record)];
  if (current) for (const ref of guards) {
    const head = store.get(ref.id);
    requireCondition(head && canonical(reference(head)) === canonical(ref), 'runtime_observation_scope_stale',
      `Observe the exact current OM declaration: ${ref.id}`);
  }
  return { obligations: found.value.handoff.obligations, guards: current ? guards : [] };
}

/** The provider-classification set for the check module input: the sorted
 * unique union of every executable the exact verified declaration names, not
 * only the check being launched — a foreign provider may be declared by a
 * sibling assignment. */
function declaredExecutables(assignments: readonly { readonly runtimeCheck?: { readonly executables?: readonly string[] | null } | null }[]): string[] {
  return [...new Set(assignments.flatMap(item => item.runtimeCheck?.executables ?? []))].sort();
}

/** Address selection does not prove authority; omRuntimeAssignment checks the
 * complete declaration before accepting this address for an observation. */
export function runtimeObligationId(obligation: CarriedObligation): string {
  requireCondition(obligation && isRef(obligation.scope) && typeof obligation.obligation === 'string'
    && obligation.obligation.length > 0, 'runtime_check_not_declared', 'An observation needs an exact carried assignment');
  if (obligation.scope.id.startsWith('om-obligations:')) requireCondition(obligation.original && isRef(obligation.original.record)
    && typeof obligation.original.pointer === 'string' && obligation.original.pointer.length > 0
    && typeof obligation.responsibleNode === 'string' && obligation.responsibleNode.length > 0
    && typeof obligation.responsibleConsumer === 'string' && obligation.responsibleConsumer.length > 0,
  'runtime_check_not_declared', 'An OM observation needs both responsible addresses of its original assignment');
  return obligation.scope.id.startsWith('om-obligations:') ? taskBindingId(obligation) : obligation.obligation;
}

export function omRuntimeAssignment(store: Store, project: string, scope: Ref, id: string, current = false) {
  const declaration = omRuntimeDeclaration(store, project, scope, current);
  const matches = declaration.obligations.filter(item => runtimeObligationId(item as CarriedObligation) === id);
  if (matches.length !== 1) throw new EngineError('runtime_check_not_declared',
    'An OM runtime check must address exactly one declared assignment', { scope, obligation: id });
  return { assignment: matches[0]!, obligations: declaration.obligations, guards: declaration.guards };
}

function observationDeclaration(store: Store, project: string, request: RuntimeObservationRequest) {
  if (request.scope.id.startsWith('om-obligations:')) {
    const found = omRuntimeAssignment(store, project, request.scope, request.obligation, true);
    return { scope: { ...found.assignment.scope }, assignment: found.assignment, guards: found.guards,
      executables: declaredExecutables(found.obligations) };
  }
  const scope = researchScope(store, project);
  requireCondition(scope && canonical(reference(scope)) === canonical(request.scope),
    'runtime_observation_scope_stale', 'Observe the exact current scope');
  return { scope: reference(scope), assignment: obligationAssignment(scope.value, request.obligation), guards: [reference(scope)],
    executables: declaredExecutables(scope.value.policy?.assignments ?? []) };
}

export function runtimeContext(store: Store, project: string) {
  const effective = new Environments(store).effective(project), configured = store.get(`reader-pilot:${project}`);
  const pilot = readerPilot(store,project), checked = store.get(`reader-pilot:${project}`);
  requireCondition(canonical(checked ? reference(checked) : null) === canonical(configured ? reference(configured) : null),
    'runtime_observation_stale', 'The reader configuration changed while its runtime binding was checked');
  const binding = { environment:effective.environment.value,root:effective.root,
    identity:{uid:process.getuid?.()??null,gid:process.getgid?.()??null,euid:process.geteuid?.()??null,egid:process.getegid?.()??null,groups:process.getgroups?.().sort((a,b)=>a-b)??[]},
    // PATH is checked through resolved declared executables: an irrelevant
    // prefix must not invalidate evidence. Do not publish arbitrary env/secrets.
    processEnvironment:Object.fromEntries(['HOME','USERPROFILE','SystemRoot','WINDIR','TMPDIR','TEMP','TMP','LANG','LC_ALL'].map(key=>[key,process.env[key]??null])),
    pilot:pilot ? {reader:pilot.value.reader,agentCommand:pilot.value.agentCommand,callTimeoutMs:pilot.value.callTimeoutMs??null} : null,
    platform:{os:platform(),release:release(),arch:arch(),node:process.version} };
  return { ...effective,binding:binding as unknown as Json,
    guards:uniqueRefs([reference(effective.environment),...effective.guards,...(configured?[reference(configured)]:[])]),
    admissionGuards:uniqueTransactionGuards([...effective.admissionGuards,...(configured?[]:[{id:`reader-pilot:${project}`,absent:true as const}])]) };
}

/** The declared check-code selection shared by current admission and
 * historical proof: an operator module (no code root) is its single inline
 * owner-document script without dependencies; repository code is the script
 * plus every declared dependency — each a project file inside the saved code
 * root. The caller's `read` chooses the era — head records for admission,
 * exact saved revisions for proof — and `inside` its root containment. */
export function declaredCheckSources(project: string, check: RuntimeCheck, codeRoot: string | null,
  read: (ref: Ref) => Revision<Source> | null | undefined,
  inside: (root: string, location: string) => boolean): Revision<Source>[] | null {
  if (!isRef(check.script) || !Array.isArray(check.dependencies) || !check.dependencies.every(isRef)) return null;
  const valid = (source: Revision<Source> | null | undefined): source is Revision<Source> =>
    !!source && source.kind === 'source' && source.value.projectId === project
    && ['text/plain', 'application/json'].includes(source.value.mediaType) && !!source.value.content.trim();
  if (codeRoot === null) {
    if (check.dependencies.length !== 0) return null;
    const script = read(check.script);
    return valid(script) && script.value.origin.kind === 'owner-document' && !script.value.provenance
      && script.value.mediaType === 'text/plain' ? [script] : null;
  }
  const code: Revision<Source>[] = [];
  for (const ref of uniqueRefs([check.script, ...check.dependencies])) {
    const source = read(ref);
    if (!valid(source) || source.value.origin.kind !== 'file' || !inside(codeRoot, source.value.origin.location))
      return null;
    code.push(source);
  }
  return code;
}

export function runtimeCode(store: Store, project: string, check: RuntimeCheck, root: string | null): Observation[] {
  const evidence = new Evidence(store);
  const code = declaredCheckSources(project, check, root,
    ref => {
      const source = store.get<Source>(ref.id);
      return source?.kind === 'source' && canonical(reference(source)) === canonical(ref) ? source : null;
    },
    (codeRoot, location) => realpathSync(workspacePath(codeRoot, relative(codeRoot, location))) === location);
  requireCondition(code, 'runtime_check_source_invalid',
    'The declared check code is missing, foreign or outside its workspace');
  return code.map(source =>
    evidence.observe(project, reference(source), { kind: 'text-range', start: 0, end: source.value.content.length }));
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

export async function executableHash(path: string): Promise<string> {
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
export async function observeRuntime(store: Store, project: string, request: RuntimeObservationRequest, signal?: AbortSignal, stopHooks?: ProcessStopHooks): Promise<RuntimeObservationResult> {
  requireCondition(request && isRef(request.scope) && (request.scope.id===`research-scope:${project}:R2` || request.scope.id.startsWith('om-obligations:'))
    && typeof request.obligation==='string' && request.obligation.trim() && typeof request.key==='string' && request.key.trim(),
  'runtime_observation_invalid','An observation needs its exact scope, obligation and stable operation key');
  const id=`runtime-observation:${hashJson([project,request.key])}`,old=store.get<RuntimeObservation>(id);
  if(old){
    requireCondition(old.kind==='runtime-observation' && old.value.projectId===project && old.value.key===request.key
      && canonical(old.value.scope)===canonical(request.scope) && old.value.requestedFor===request.obligation,
    'runtime_observation_conflict','The operation key already belongs to another observation');
    return recordedResult(store,old);
  }
  const declaration=observationDeclaration(store,project,request),scope=declaration.scope,assignment=declaration.assignment;
  requireCondition(assignment?.kind==='environment-confirmation' && assignment.runtimeCheck,
    'runtime_check_not_declared','The owner policy must declare the check; the model cannot select a program');
  const check=structuredClone(assignment.runtimeCheck) as RuntimeCheck,current=runtimeContext(store,project),codeRoot=checkCodeRoot(store,project,check,current),code=runtimeCode(store,project,check,codeRoot);
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
  const guards=uniqueRefs([...declaration.guards,...current.guards,...code.map(o=>o.source)]);
  let record:Revision<RuntimeObservation>;
  try {
    record=store.writeMany<RuntimeObservation>([{id,kind:'runtime-observation',expected:0,value:{version:1,projectId:project,key:request.key,
      scope,requestedFor:request.obligation,check,environment:reference(current.environment),context:guards,root:current.root,codeRoot,
      runtimeBinding:current.binding,platform:{os:platform(),release:release(),arch:arch(),node:process.version},executable,subjects,
      snapshot:null,invocation:null,owner:{pid:owner.pid,started:owner.started},child:null,startedAt:Date.now(),finishedAt:null,status:'running',result:null,error:null} satisfies RuntimeObservation},
      {id:counterId,kind:'project-dispatch',expected:counter?.revision??0,value:{projectId:project,serial:(counter?.value.serial??0)+1}}],
    uniqueTransactionGuards([...guards,...current.admissionGuards]))[0]!;
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
  let spawnedPid:number|null=null;
  let keepResources=false;
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
      canonical({protocol:'omg-runtime-observation/v1',scope,obligation:assignment.original,runtime:current.binding,
        executables:declaration.executables}),check.timeoutMs,signal,true,pid=>{
        spawnedPid=pid;
        const started=processStart(pid);
        if(!started){
          // kill(pid,0) is a liveness probe, not a group signal: EPERM also
          // proves the child exists — it can never stand in for absence.
          let probeErrno:string|null=null;
          try{process.kill(pid,0);}catch(error){probeErrno=(error as NodeJS.ErrnoException)?.code??'unknown';}
          if(probeErrno==='ESRCH')return;
          throw new EngineError('process_identity_unavailable','A live check child must have a provable exact identity',
            {stage:'identity-probe',target:'child',pid,expectedStarted:null,observedStarted:null,errno:probeErrno});
        }
        record=store.write<RuntimeObservation>({id:record.id,kind:record.kind,expected:record.revision,value:{...record.value,child:{pid,started}}});
      },stopHooks);
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
      {id:source.id,kind:'source',expected:0,value:source.value}],
    uniqueTransactionGuards([reference(record),...declaration.guards,...after.guards,...current.admissionGuards,...after.admissionGuards,...code.map(o=>o.source)]));
    return {observation:saved[0]! as Revision<RuntimeObservation>,source:saved[1]! as Revision<Source>};
  } catch(error) {
    const code=error instanceof EngineError?error.code:'runtime_observation_failed';
    const stopDetails=error instanceof EngineError?error.details as Record<string,unknown>|null:null;
    const refusal=['process_stop_denied','process_stop_unconfirmed','process_stop_failed'].includes(code)
      ||(code==='process_identity_unavailable'&&stopDetails!==null&&typeof stopDetails==='object'&&'outcome' in stopDetails);
    // An unproven stop frees nothing: the child may still execute from the
    // snapshot, and the running record keeps its identity for explicit retry.
    // The same holds for any failure after spawn that left no committed child
    // identity — a bare identity refusal is recoverable only through the
    // witness, never through a failed terminal.
    if(refusal||(spawnedPid!==null&&record.value.child===null)){
      keepResources=true;
      writeProcessStopWitness(store,reference(record),{owner:record.value.owner,child:record.value.child,pid:spawnedPid},error);
      throw error;
    }
    record=store.write<RuntimeObservation>({id:record.id,kind:record.kind,expected:record.revision,value:{...record.value,
      status:['input_stale','revision_conflict','runtime_check_source_invalid','source_stale','runtime_observation_stale'].includes(code)?'stale':'failed',
      child:null,finishedAt:Date.now(),result,error:`${code}: ${error instanceof Error?error.message:'Check failed'}`}});
    return {observation:record,source:null};
  } finally {if(snapshot&&!keepResources)rmSync(snapshot,{recursive:true,force:true});}
}

export function recoverRuntimeObservation(store:Store,project:string,ref:Ref,stopHooks?:ProcessStopHooks):Revision<RuntimeObservation>{
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
  const owner=(stopHooks?.identify??probeProcessIdentity)(record.value.owner.pid);
  if(owner.state==='unavailable')throw new EngineError('process_identity_unavailable',
    'The recorded observer identity cannot be verified; an unverifiable owner is not a dead owner',
    {stage:'pre-check',target:'owner',pid:record.value.owner.pid,expectedStarted:record.value.owner.started,observedStarted:null,errno:owner.errno});
  requireCondition(!(owner.state==='present'&&owner.started===record.value.owner.started),
    'runtime_observation_busy','The observer is still alive; do not interrupt its work');
  const child=record.value.child;
  if(child){
    const present=(stopHooks?.identify??probeProcessIdentity)(child.pid);
    if(present.state==='present'&&present.started===child.started)
      requireCondition(process.platform!=='win32','runtime_recovery_unsupported','Process-group recovery requires the supported POSIX runtime');
    const stop=stopOwnedGroup(child,stopHooks);
    // Only a proven absence, a confirmed stop or a changed identity lets the
    // record close; every refusal leaves it running for an explicit retry.
    if(!['absent','stopped','identity-changed'].includes(stop.outcome)){
      const refusal=processStopRefusal(stop,'The recorded check child could not be provably stopped; the observation stays running for an explicit retry');
      writeProcessStopWitness(store,reference(record),{owner:record.value.owner,child:record.value.child},refusal);
      throw refusal;
    }
  }
  // A process-stop witness may carry a spawned pid that was never committed
  // as record identity — a refused child write still left an OS process.
  // Its end must be proven before the running record closes; a child:null
  // record without such a witness keeps its legacy lawful close.
  for(const verdict of evaluateProcessStopWitnesses(store,record.id,stopHooks?.identify??probeProcessIdentity)){
    if(verdict.state==='ended')continue;
    const report:ProcessStopReport={outcome:verdict.state==='unavailable'?'identity-unavailable':'unconfirmed',stage:'post-check',target:'child',
      pid:verdict.witness.pid,expectedStarted:verdict.witness.child?.started??null,
      observedStarted:verdict.observedStarted,errno:verdict.errno};
    const refusal=processStopRefusal(report,'A spawned process recorded only in the stop witness has no proven end; the observation stays running for an explicit retry');
    writeProcessStopWitness(store,reference(record),{owner:record.value.owner,child:record.value.child,pid:verdict.witness.pid},refusal);
    throw refusal;
  }
  return store.write<RuntimeObservation>({id:record.id,kind:record.kind,expected:record.revision,
    value:{...record.value,status:'failed',child:null,finishedAt:Date.now(),error:'runtime_observation_interrupted: observer process ended; use a new operation key for an explicit retry'}});
}
