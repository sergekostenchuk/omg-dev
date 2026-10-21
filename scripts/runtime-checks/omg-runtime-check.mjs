// Operator-owned executable evidence. This module is intentionally self-contained:
// its exact bytes are imported as owner-document code, never as an assertion of fact.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, platform, release, arch } from 'node:os';
import { join, resolve, delimiter, basename } from 'node:path';
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
  // executables is the declared provider set for classification: a required array of
  // non-empty names ([] is lawful); its absence or a malformed element is refused up front.
  requireThat(input?.protocol === 'omg-runtime-observation/v1' && validRef(input.scope) && validRef(input.obligation?.record)
    && typeof input.obligation.pointer === 'string' && input.runtime?.environment?.projectId
    && input.scope.id === `research-scope:${input.runtime.environment.projectId}:R2`
    && Array.isArray(input.executables) && input.executables.every(name => typeof name === 'string' && name.length > 0)
    && realpathSync(input.runtime.root) === realpathSync(process.cwd()), 'runtime_input_invalid');
  return input.runtime;
}

// The closed adapter table, duplicated intentionally: this module is self-contained owner evidence.
// versionPattern is frozen data, never the live RegExp: a frozen RegExp still mutates through
// compile(), so every check builds an independent matcher from source/flags at the point of use.
export const KNOWN_ADAPTERS = Object.freeze({
  'codex-stdio.js': Object.freeze({ protocol: 'codex-stdio', executable: 'codex', versionPattern: Object.freeze({ source: '^codex-cli [^\\r\\n]+\\s*$', flags: '' }) }),
  'devin-stdio.js': Object.freeze({ protocol: 'devin-stdio', executable: 'devin', versionPattern: Object.freeze({ source: '^devin [^\\r\\n]+\\s*$', flags: '' }) }),
});
/** The provider a role command actually launches. A known module names its provider. An unknown
 * module keeps the Codex era only while the exact declaration names no foreign provider
 * executable; a declared foreign provider is unprovable — null, never Codex by substitution. */
function classifyProvider(command, executables) {
  const entry = Array.isArray(command?.args) ? command.args[0] : undefined;
  const known = typeof entry === 'string' && !entry.startsWith('-') ? KNOWN_ADAPTERS[basename(entry)] : undefined;
  if (known) return known;
  return executables.some(name => Object.values(KNOWN_ADAPTERS).some(provider => provider.protocol !== 'codex-stdio' && provider.executable === basename(name)))
    ? null : KNOWN_ADAPTERS['codex-stdio.js'];
}
/** Every provider the declared runtime actually names: pilot.agentCommand substitutes the main roles'
 * commands, and the reader pilot's own command is counted separately. */
function runtimeProviders(runtime, executables) {
  const commands = runtime.pilot?.agentCommand
    ? [runtime.pilot.agentCommand]
    : [runtime.environment?.implementer, runtime.environment?.reviewer].filter(Boolean).map(role => role.command);
  if (runtime.pilot?.reader?.command) commands.push(runtime.pilot.reader.command);
  const providers = [...new Map(commands.map(command => {
    const provider = classifyProvider(command, executables); return [provider?.protocol ?? '', provider];
  })).values()];
  return providers.length ? providers : [KNOWN_ADAPTERS['codex-stdio.js']];
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
  // Devin has no local sandbox command to certify here; a Codex canary never counts as Devin
  // isolation, and an unprovable provider gets no Codex certification either.
  requireThat(runtimeProviders(runtime, input.executables).every(provider => provider?.protocol === 'codex-stdio'), 'sandbox_provider_unsupported');
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
  const providers = runtimeProviders(runtime, input.executables);
  // A provider whose module the declaration cannot attribute is probed as nothing: the run
  // refuses instead of reporting full success over a silently skipped provider.
  requireThat(providers.every(provider => provider !== null), 'runtime_provider_unknown');
  for (const name of [...new Set(['node','npm','git',...providers.map(provider => provider.executable)])]) {
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
    limits:['This is the observed platform, not a supported OS/browser matrix.','Model compatibility is not provable by this module: its call-runtime evidence was retired (LG84).'] };
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
  } };
}

export function providerCompatibility(input, database) {
  const runtime = runtimeInput(input), db = openEvidenceDatabase(database,runtime.environment.projectId);
  try {
    const scope = db.get(input.scope,true); requireThat(scope.kind === 'research-scope' && scope.value.policy, 'scope_policy_missing');
    // The classification set carried in the input must equal the one computed from the
    // exact stored declaration — a caller cannot relabel which providers were declared.
    const declared = [...new Set(scope.value.policy.assignments.flatMap(item => item.runtimeCheck ? item.runtimeCheck.executables : []))].sort();
    requireThat(same([...new Set(input.executables)].sort(), declared), 'runtime_input_invalid');
    // LG84: the call-runtime evidence this check read is retired. No recorded call — old or new —
    // proves provider compatibility here any more, and the absence of evidence is never an admission.
    requireThat(false, 'compatible_call_unavailable');
  } finally { db.close(); }
}

export function integrationReadiness(input, database) {
  // LG84: integration requires provider compatibility first, which this module can no longer prove.
  return providerCompatibility(input,database);
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
