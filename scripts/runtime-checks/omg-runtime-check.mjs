// Operator-owned executable evidence. This module is intentionally self-contained:
// its exact bytes are imported as owner-document code, never as an assertion of fact.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, platform, release, arch } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])]));
  return value;
}
function requireThat(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }
const same = (a, b) => canonical(a) === canonical(b);
function hashFile(path) {
  const fd=openSync(path,'r'), digest=createHash('sha256'),buffer=Buffer.alloc(65536);
  try { for(let count;(count=readSync(fd,buffer,0,buffer.length,null))>0;)digest.update(buffer.subarray(0,count)); return digest.digest('hex'); }
  finally { closeSync(fd); }
}
const refOf = row => ({ id: row.id, revision: row.revision, hash: row.hash });
const validRef = ref => ref && typeof ref.id === 'string' && Number.isSafeInteger(ref.revision) && ref.revision > 0 && /^[a-f0-9]{64}$/.test(ref.hash);
function identity(path) { const s = statSync(path); requireThat(s.isFile(), 'subject_not_file'); return Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs'].map(key => [key,s[key]])); }
function executable(name, cwd) {
  const paths = name.includes('/') ? [resolve(cwd, name)] : (process.env.PATH ?? '').split(delimiter).map(path => resolve(cwd, path || '.', name));
  for (const path of paths) try { if (statSync(path).isFile() && statSync(path).mode & 0o111) return realpathSync(path); } catch {}
  throw Object.assign(new Error('executable_unavailable'), { code: 'executable_unavailable' });
}

export function runCommand(command, cwd, input = '', timeout = 5000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command.executable, command.args, { cwd, env: process.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const output = { stdout: '', stderr: '', exitCode: null, signal: null }; let failure = null, bytes = 0;
    const stop = () => { if (!child.pid) return; try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { failure = 'command_timeout'; stop(); }, timeout);
    for (const stream of ['stdout','stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length; if (bytes > 200000) { failure = 'command_output_limit'; stop(); } else output[stream] += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { failure = 'command_unavailable'; });
    child.once('exit', stop);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); output.exitCode = exitCode; output.signal = signal;
      if (failure) reject(Object.assign(new Error(failure), { code: failure, observation: output })); else resolveResult(output);
    });
    child.stdin.end(input);
  });
}

function runtimeInput(input) {
  requireThat(input?.protocol === 'omg-runtime-observation/v1' && validRef(input.scope) && validRef(input.obligation?.record)
    && typeof input.obligation.pointer === 'string' && input.runtime?.environment?.projectId
    && input.scope.id === `research-scope:${input.runtime.environment.projectId}:R2`
    && realpathSync(input.runtime.root) === realpathSync(process.cwd()), 'runtime_input_invalid');
  return input.runtime;
}

const canaryProgram = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
const data=JSON.parse(process.argv[1]);const results=[];
for(const item of data.files){try{let matches=null;if(item.operation==='read')matches=fs.readFileSync(item.path,'utf8')===data.marker;
else if(item.operation==='write')fs.appendFileSync(item.path,'probe');else{const fd=fs.openSync(item.path,'r+');fs.closeSync(fd);}
results.push({id:item.id,path:item.path,operation:item.operation,allowed:true,matches});}catch(e){results.push({id:item.id,path:item.path,operation:item.operation,allowed:false,code:e.code??'unknown'});}}
const socket=net.createConnection({host:'127.0.0.1',port:data.port});let complete=false;
const finish=allowed=>{if(complete)return;complete=true;socket.destroy();const output={files:results,network:{kind:'own-loopback',allowed},pid:process.pid};
if(data.descendant){const child=cp.spawnSync(process.execPath,['-e',data.program,JSON.stringify({...data,descendant:false})],{encoding:'utf8',timeout:2500});
try{output.descendant=JSON.parse(child.stdout);}catch{output.descendant={error:'descendant_not_observed',exitCode:child.status,signal:child.signal};}}
console.log(JSON.stringify(output));};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(700,()=>finish(false));`;

/** --sandbox mode is a supported config key in the installed 0.153 CLI.
 * Its local help uses `sandbox [OPTIONS] [COMMAND]`, without `macos`.
 * Do not run codex exec: that would be a separate paid probe. */
export function sandboxCommand(mode, root, payload) {
  requireThat(['read-only','workspace-write'].includes(mode), 'sandbox_mode_invalid');
  return { executable: executable('codex', root), args: ['sandbox','-c',`sandbox_mode=${JSON.stringify(mode)}`,
    '-C',root,'--',process.execPath,'-e',canaryProgram,JSON.stringify({ ...payload, program: canaryProgram, descendant: true })] };
}

export async function isolation(input, run = runCommand) {
  const runtime = runtimeInput(input), owned = [], server = createServer(socket => socket.end());
  try {
    const workspace = mkdtempSync(join(runtime.root, '.omg-canary-')); owned.push(workspace);
    const home = mkdtempSync(join(homedir(), '.omg-canary-')); owned.push(home);
    await new Promise((resolveServer, reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolveServer); });
    const port = server.address().port, marker = randomUUID();
    const git = await run({ executable: executable('git', runtime.root), args: ['rev-parse','--path-format=absolute','--git-path','config'] }, runtime.root);
    requireThat(git.exitCode === 0 && git.signal === null, 'git_metadata_unavailable');
    const gitConfig = resolve(runtime.root,git.stdout.trim()); requireThat(existsSync(gitConfig), 'git_metadata_unavailable');
    const metadataBefore = hashFile(gitConfig);
    const matrix = [];
    for (const mode of ['read-only','workspace-write']) {
      const paths = { workspaceRead: join(workspace, `${mode}-read.txt`), taskWrite: join(workspace, `${mode}-task.txt`),
        outsideTaskWrite: join(workspace, `${mode}-outside-task.txt`), homeRead: join(home, `${mode}-credentials-canary.json`),
        homeWrite: join(home, `${mode}-write.txt`) };
      for (const path of Object.values(paths)) writeFileSync(path, marker, { mode: 0o600, flag: 'wx' });
      const files = [
        { id:'workspace-read',operation:'read',path:paths.workspaceRead }, { id:'task-write',operation:'write',path:paths.taskWrite },
        { id:'outside-task-write',operation:'write',path:paths.outsideTaskWrite }, { id:'home-canary-read',operation:'read',path:paths.homeRead },
        { id:'home-canary-write',operation:'write',path:paths.homeWrite }, { id:'git-open-for-write',operation:'open-write',path:gitConfig },
      ];
      const command = sandboxCommand(mode, runtime.root, { files, marker, port });
      let result;
      try { result = await run(command, runtime.root, '', 6000); }
      catch(error) { error.observation={kind:'isolation-observation',completed:false,matrix,requestedMode:mode,partial:error.observation??null}; throw error; }
      let observation = null; try { observation = JSON.parse(result.stdout); } catch {}
      matrix.push({ requestedMode: mode, command: { executable: command.executable, args: command.args.slice(0,7) }, result, observation });
      if(!(result.exitCode === 0 && result.signal === null && observation?.files?.length === files.length
        && observation.descendant?.files?.length === files.length))throw Object.assign(new Error('sandbox_observation_incomplete'),
        {code:'sandbox_observation_incomplete',observation:{kind:'isolation-observation',completed:false,matrix}});
    }
    requireThat(hashFile(gitConfig) === metadataBefore, 'git_metadata_changed');
    return { kind: 'isolation-observation', completed: true, matrix,
      limits: ['Access to own canary data is measured, never actual credential contents.',
        'Git metadata is only opened for writing and immediately closed; no bytes are written.',
        'The own loopback endpoint is tested; arbitrary external hosts and all network transports are not certified.',
        'Only the local sandbox command route and its descendants were exercised; MCP/app/cloud access and model tool selection are not certified.',
        'Mode names are requested config values; observed permissions, including any unexpected allowed access, are preserved.',
        'Workspace-write is not assumed to enforce task.writePaths. Compare the outside-task canary.',
        'A completed observation does not mean the environment denied every access or satisfies every product requirement.'] };
  } finally {
    if(server.listening)server.close();
    // Only directories created by this invocation are removed. Existing source,
    // Git, configuration and credential files are never modified or removed.
    for (const path of owned.reverse()) rmSync(path, { recursive: true, force: true });
  }
}

export async function platformReadiness(input, run = runCommand) {
  const runtime = runtimeInput(input), versions = {};
  requireThat(platform() !== 'win32', 'posix_runtime_required');
  for (const name of ['node','npm','git','codex']) {
    const command = { executable: name === 'node' ? process.execPath : executable(name, runtime.root), args: ['--version'] };
    const result = await run(command, runtime.root); requireThat(result.exitCode === 0 && result.signal === null && result.stdout.trim(), `${name}_version_unavailable`);
    versions[name] = { command, result };
  }
  const ps = await run({ executable: executable('ps', runtime.root), args: ['-p',String(process.pid),'-o','pid=','-o','lstart=','-o','pgid='] }, runtime.root);
  requireThat(ps.exitCode === 0 && ps.signal === null && ps.stdout.includes(String(process.pid)), 'process_identity_unavailable');
  const groupProgram = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{detached:true,stdio:'ignore'});child.once('spawn',()=>{process.kill(-child.pid,'SIGTERM');});child.once('exit',(code,signal)=>{console.log(JSON.stringify({pid:child.pid,signal,exitCode:code}));process.exitCode=signal==='SIGTERM'?0:1;});`;
  const group = await run({ executable: process.execPath, args: ['-e',groupProgram] }, runtime.root);
  requireThat(group.exitCode === 0 && group.signal === null && JSON.parse(group.stdout).signal === 'SIGTERM', 'process_group_unavailable');
  return { kind:'runtime-readiness',completed:true,platform:{os:platform(),release:release(),arch:arch(),node:process.version},versions,ps,group,
    limits:['This is the observed platform, not a supported OS/browser matrix.','Model compatibility is checked separately against an actual bound ordinary call.'] };
}

function openEvidenceDatabase(path, project) {
  requireThat(typeof path === 'string' && resolve(path) === path, 'evidence_database_path_required');
  const db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA query_only=ON'); db.exec('BEGIN');
  const decode = row => {
    if (!row) return null; requireThat(hash(row.body) === row.sha256, 'evidence_record_corrupt');
    const value = JSON.parse(row.body); requireThat(value.projectId === project, 'evidence_project_foreign');
    return { id:row.entity_id,revision:row.revision,hash:row.sha256,kind:row.kind,value };
  };
  return { close:()=>db.close(), get:(ref,current=false)=>{
    requireThat(validRef(ref), 'evidence_reference_invalid');
    const row = current ? db.prepare('SELECT r.* FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.entity_id=?').get(ref.id)
      : db.prepare('SELECT * FROM revisions WHERE entity_id=? AND revision=?').get(ref.id,ref.revision);
    const record = decode(row); requireThat(record && same(refOf(record),ref), 'evidence_reference_stale'); return record;
  }, calls:()=>db.prepare("SELECT r.* FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.kind='model-call' AND json_extract(r.body,'$.projectId')=? AND json_extract(r.body,'$.runtime.status')='observed' AND json_extract(r.body,'$.status')='succeeded' ORDER BY json_extract(r.body,'$.finishedAt') DESC,r.entity_id").all(project).map(decode),
  observations:()=>db.prepare("SELECT r.* FROM revisions r JOIN heads h USING(entity_id,revision) WHERE r.kind='runtime-observation' AND json_extract(r.body,'$.projectId')=? ORDER BY json_extract(r.body,'$.startedAt') DESC,r.entity_id").all(project).map(decode) };
}

function expectedSubjects(scope) {
  const checks=scope.policy.assignments.flatMap(item=>item.runtimeCheck?[item.runtimeCheck]:[]);
  return [...[...new Set(checks.flatMap(check=>check.subjects))].sort().map(requested=>({requested,kind:'file'})),
    ...[...new Set(checks.flatMap(check=>check.executables))].sort().map(requested=>({requested,kind:'executable'}))];
}
function currentFiles(snapshot, runtime, scope) {
  requireThat(snapshot && same(snapshot.binding,runtime) && snapshot.root === runtime.root, 'call_runtime_foreign');
  requireThat(Array.isArray(snapshot.subjects) && same(snapshot.subjects.map(({requested,kind})=>({requested,kind})),expectedSubjects(scope)),
    'call_subject_set_incomplete');
  const files = [snapshot.interpreter,...snapshot.subjects];
  requireThat(snapshot.adapter && snapshot.subjects.some(file=>same(file,snapshot.adapter)), 'call_adapter_missing');
  const codex=snapshot.subjects.find(file=>file.kind==='executable'&&file.requested==='codex');
  requireThat(codex && snapshot.codex?.executable===codex.path && same(snapshot.codex.args,['--version'])
    && snapshot.codex.result?.exitCode===0 && snapshot.codex.result.signal===null
    && typeof snapshot.codex.result.stdout==='string' && snapshot.codex.result.stdout.length<=4096
    && /^codex-cli [^\r\n]+\s*$/.test(snapshot.codex.result.stdout),'call_version_missing');
  for (const file of files) {
    const actual = file.kind === 'executable' ? executable(file.requested,runtime.root) : realpathSync(resolve(runtime.root,file.requested));
    requireThat(actual === file.path && same(identity(actual),file.identity) && hashFile(actual) === file.hash
      && same(identity(actual),file.identity), 'call_runtime_stale');
  }
}

export function providerCompatibility(input, database) {
  const runtime = runtimeInput(input), db = openEvidenceDatabase(database,runtime.environment.projectId);
  try {
    const scope = db.get(input.scope,true); requireThat(scope.kind === 'research-scope' && scope.value.policy, 'scope_policy_missing');
    const required = [runtime.environment.implementer, runtime.environment.reviewer].map(role=>({...role,command:runtime.pilot?.agentCommand??role.command}));
    if(runtime.pilot?.reader)required.push(runtime.pilot.reader);
    const settings = [...new Map(required.map(role=>[canonical([role.model,role.effort,role.speed??'inherited']),{model:role.model,effort:role.effort,speed:role.speed??'inherited'}])).values()];
    const found = [];
    for (const setting of settings) {
      let matching = null;
      for (const row of db.calls()) try {
        const call = row.value, evidence = call.runtime, snapshot = evidence.snapshot;
        requireThat(evidence.version === 1 && same(evidence.declaration,input.scope) && evidence.error === null
          && same(setting,{model:call.requested.model,effort:call.requested.effort,speed:call.requested.speed??'inherited'})
          && snapshot.roleHash === hash(canonical(call.requested)) && evidence.requestHash === call.request.hash, 'call_binding_foreign');
        requireThat(required.some(role=>role.model===call.requested.model && role.effort===call.requested.effort
          && (role.speed??'inherited')===(call.requested.speed??'inherited') && same(role.command,call.requested.command))
          && same(snapshot.invocation.args,call.requested.command.args)
          && snapshot.invocation.executable===executable(call.requested.command.executable,runtime.root)
          && snapshot.adapter.path===realpathSync(resolve(runtime.root,call.requested.command.args[0])), 'call_command_foreign');
        currentFiles(snapshot,runtime,scope.value);
        const requestRow = db.get(call.request.record), responseRow = db.get(call.response.record);
        requireThat(requestRow.kind === 'model-request' && responseRow.kind === 'model-response'
          && requestRow.value.draftId === call.draftId && responseRow.value.draftId === call.draftId
          && hash(requestRow.value.text) === call.request.hash && requestRow.value.text.length === call.request.chars
          && Buffer.byteLength(requestRow.value.text) === call.request.bytes && responseRow.value.text.length === call.response.chars
          && Buffer.byteLength(responseRow.value.text) === call.response.bytes, 'call_wire_foreign');
        const request = JSON.parse(requestRow.value.text), response = JSON.parse(responseRow.value.text);
        const context=db.get(call.packet?.archive),draft=db.get(context.value.draft);
        requireThat(context.kind==='research-context' && context.value.draft.id===call.draftId
          && draft.kind==='discovery-draft' && draft.value.stage==='om-g2' && draft.value.level==='R2'
          && draft.value.inputs.some(ref=>same(ref,input.scope)) && same(request.subject?.working?.archive,call.packet.archive),
          'call_research_basis_foreign');
        requireThat(request.protocol === 'omg-agent/v1' && response.protocol === request.protocol && request.requestId === call.requestId
          && response.requestId === call.requestId && request.mode === 'research' && Object.hasOwn(response,'research')
          && response.research && typeof response.research==='object' && !Array.isArray(response.research)
          && request.model === setting.model && request.effort === setting.effort && (request.speed??'inherited') === setting.speed,
        'call_protocol_foreign');
        matching = { call:refOf(row),request:refOf(requestRow),response:refOf(responseRow),requested:setting,confirmed:call.confirmed,
          startedAt:call.startedAt,finishedAt:call.finishedAt,command:call.requested.command,adapter:snapshot.adapter,codex:snapshot.codex,mode:request.mode };
        break;
      } catch { /* A foreign or incomplete call cannot fill this setting. */ }
      requireThat(matching, 'compatible_call_unavailable'); found.push(matching);
    }
    return {kind:'provider-compatibility',completed:true,calls:found,
      limits:['Only the recorded ordinary research mode and requested settings were exercised.','Null confirmed model/effort/speed remain unknown.','No extra paid probe, implementation or review execution was performed by this check.']};
  } finally { db.close(); }
}

export function integrationReadiness(input, database) {
  const compatibility = providerCompatibility(input,database), runtime = runtimeInput(input), db = openEvidenceDatabase(database,runtime.environment.projectId);
  try {
    const scope = db.get(input.scope,true), assignment = scope.value.policy.assignments.find(item=>same(item.original,input.obligation));
    requireThat(assignment, 'obligation_foreign');
    const observations = [];
    for (const target of scope.value.policy.assignments.filter(item=>item.kind==='environment-confirmation' && item.moment==='R2' && item.runtimeCheck)) {
      const latest = db.observations().find(row=>same(row.value.scope,input.scope) && same(row.value.check,target.runtimeCheck));
      requireThat(latest && latest.value.status === 'observed' && latest.value.result?.exitCode === 0 && latest.value.result.signal === null
        && same(latest.value.runtimeBinding,runtime), 'isolation_observation_unavailable');
      const observation=latest.value;
      requireThat(observation.version===1 && observation.root===runtime.root && observation.executable.path===realpathSync(process.execPath)
        && same(identity(observation.executable.path),observation.executable.identity)
        && hashFile(observation.executable.path)===observation.executable.hash, 'isolation_runtime_stale');
      const wanted=[...target.runtimeCheck.subjects.map(requested=>({requested,kind:'file'})),...target.runtimeCheck.executables.map(requested=>({requested,kind:'executable'}))];
      requireThat(same(observation.subjects.map(({requested,kind})=>({requested,kind})),wanted),'isolation_subject_set_incomplete');
      for(const subject of observation.subjects){
        const path=subject.kind==='executable'?executable(subject.requested,runtime.root):realpathSync(resolve(runtime.root,subject.requested));
        requireThat(path===subject.path && same(identity(path),subject.identity) && hashFile(path)===subject.hash
          && same(identity(path),subject.identity),'isolation_runtime_stale');
      }
      for(const ref of [target.runtimeCheck.script,...target.runtimeCheck.dependencies]){
        const source=db.get(ref,true);requireThat(source.kind==='source' && hash(source.value.content)===source.value.sha256,'isolation_code_stale');
      }
      const report = JSON.parse(latest.value.result.stdout);
      requireThat(report.protocol === 'omg-runtime-check/v1' && report.result?.kind === 'isolation-observation' && report.result.completed === true,
        'isolation_observation_foreign');
      observations.push({obligation:target.obligation,observation:refOf(latest),matrix:report.result.matrix,limits:report.result.limits});
    }
    requireThat(observations.length > 0, 'isolation_declaration_missing');
    return {kind:'runtime-integration',completed:true,configuration:runtime,configurationHash:hash(canonical(runtime)),compatibility,observations,
      limits:['R2 research must interpret the observed sandbox limits; this check does not invent denied accesses.','Future implementation-result obligations remain open until their own task acceptance.']};
  } finally { db.close(); }
}

export async function runCheck(input,args,run=runCommand) {
  requireThat(Array.isArray(args) && (args.length===1 || args.length===2), 'check_arguments_invalid');
  runtimeInput(input);
  const [mode,database] = args;
  if (mode==='isolation' && args.length===1) return isolation(input,run);
  if (mode==='platform' && args.length===1) return platformReadiness(input,run);
  if (mode==='provider' && args.length===2) return providerCompatibility(input,database);
  if (mode==='integration' && args.length===2) return integrationReadiness(input,database);
  throw Object.assign(new Error('check_arguments_invalid'),{code:'check_arguments_invalid'});
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0,'utf8')), result = await runCheck(input,process.argv.slice(2));
    console.log(JSON.stringify({protocol:'omg-runtime-check/v1',scope:input.scope,obligation:input.obligation,result}));
  } catch(error) {
    console.log(JSON.stringify({protocol:'omg-runtime-check/v1',error:error.code??'runtime_check_failed',
      ...(error.observation ? {observation:error.observation} : {})})); process.exitCode=1;
  }
}
