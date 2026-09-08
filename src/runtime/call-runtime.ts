import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import type { Ref } from '../pipeline/contracts.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../storage/store.js';
import type { DiscoveryDraft } from '../discovery/discovery.js';
import type { ResearchScope } from '../graph/research-scope.js';
import type { Environment, RoleBinding } from './environment.js';
import { executablePath } from './environment.js';
import { executableHash, runtimeContext, runtimeExecutableIdentity, runtimeSubjectPath } from './runtime-observation.js';
import { runProcess, type ProcessResult } from './process.js';

interface RuntimeFile { requested: string; kind: 'file' | 'executable'; path: string; hash: string; identity: ReturnType<typeof runtimeExecutableIdentity> }
export interface CallRuntimeSnapshot {
  root: string; binding: Json; roleHash: string; invocation: RoleBinding['command'];
  interpreter: RuntimeFile; adapter: RuntimeFile; subjects: RuntimeFile[];
  codex: { executable: string; args: ['--version']; result: ProcessResult };
}
export interface CallRuntimeEvidence {
  version: 1; declaration: Ref; requestHash: string;
  status: 'captured' | 'observed' | 'unavailable' | 'stale';
  startedAt: number; finishedAt: number | null;
  snapshot: CallRuntimeSnapshot | null; error: string | null;
}

async function fingerprint(root: string, requested: string, kind: RuntimeFile['kind']): Promise<RuntimeFile> {
  const path = runtimeSubjectPath(root, requested, kind), identity = runtimeExecutableIdentity(path), hash = await executableHash(path);
  requireCondition(canonical(identity) === canonical(runtimeExecutableIdentity(path)) && runtimeSubjectPath(root, requested, kind) === path,
    'call_runtime_changed', 'A declared runtime file changed during capture');
  return { requested, kind, path, hash, identity };
}

/** Capture only the executables/files declared by the approved scope. This is
 * telemetry beside the already authorized call, never a second model probe.
 * Failure is recorded explicitly; it does not create a new dispatch gate. */
export async function captureCallRuntime(store: Store, draft: DiscoveryDraft, role: RoleBinding, environment: Environment,
  requestHash: string, signal?: AbortSignal): Promise<CallRuntimeEvidence | null> {
  const declaration = draft.inputs.find(ref => ref.id === `research-scope:${environment.projectId}:R2`);
  if (!declaration) return null;
  const scope = store.get<ResearchScope>(declaration.id, declaration.revision);
  if (!scope?.value.policy) return null; // Earlier calls retain their own era.
  const value: CallRuntimeEvidence = { version: 1, declaration, requestHash, status: 'captured', startedAt: Date.now(), finishedAt: null, snapshot: null, error: null };
  try {
    requireCondition(scope.kind === 'research-scope' && scope.hash === declaration.hash && scope.value.projectId === environment.projectId,
      'call_runtime_scope_invalid', 'Runtime evidence must use the exact declared scope');
    const checks = scope.value.policy.assignments.flatMap(assignment => assignment.runtimeCheck ? [assignment.runtimeCheck] : []);
    const executables = [...new Set(checks.flatMap(check => check.executables))].sort();
    requireCondition(executables.includes('codex'), 'call_runtime_not_declared', 'No Codex executable is declared for runtime evidence');
    const current = runtimeContext(store, environment.projectId);
    requireCondition(current.root === environment.workspace, 'call_runtime_workspace_mismatch', 'Measure the actual call workspace');
    const interpreter = await fingerprint(current.root, role.command.executable, 'executable');
    const subjects: RuntimeFile[] = [];
    for (const path of [...new Set(checks.flatMap(check => check.subjects))].sort()) subjects.push(await fingerprint(current.root, path, 'file'));
    for (const name of executables) subjects.push(await fingerprint(current.root, name, 'executable'));
    // The configured entry module must be among the explicitly declared files;
    // matching a filename such as codex-stdio.js is not an adapter identity.
    const entry = role.command.args[0];
    const adapter = entry && !entry.startsWith('-') ? subjects.find(subject => subject.kind === 'file'
      && subject.path === realpathSync(resolve(current.root, entry))) : null;
    requireCondition(adapter, 'call_runtime_adapter_not_declared', 'The actual adapter entry module must be an exact declared runtime subject');
    const codex = subjects.find(subject => subject.kind === 'executable' && subject.requested === 'codex')!;
    const versionCommand = { executable: codex.path, args: ['--version'] as ['--version'] };
    const result = await runProcess(versionCommand, current.root, '', 5000, signal);
    requireCondition(result.exitCode === 0 && result.signal === null && result.stdout.length <= 4096 && result.stderr.length <= 4096
      && /^codex-cli [^\r\n]+\s*$/.test(result.stdout), 'call_runtime_version_unavailable', 'The declared Codex did not report a bounded CLI version');
    value.snapshot = { root: current.root, binding: current.binding, roleHash: hashJson(role),
      invocation: { executable: interpreter.path, args: [...role.command.args] }, interpreter, adapter, subjects,
      codex: { ...versionCommand, result } };
    const finished = await finishCallRuntime(store, environment.projectId, value);
    requireCondition(finished.status === 'observed', finished.error ?? 'call_runtime_changed', 'Runtime changed before the authorized call');
    return value;
  } catch (error) {
    return { ...value, status: 'unavailable', finishedAt: Date.now(), error: error instanceof EngineError ? error.code : 'call_runtime_capture_failed' };
  }
}

/** Recheck after the real invocation. A changed binary, adapter, PATH target
 * or configuration invalidates the compatibility claim, not the paid answer. */
export async function finishCallRuntime(store: Store, project: string, value: CallRuntimeEvidence): Promise<CallRuntimeEvidence> {
  if (value.status !== 'captured' || !value.snapshot) return value;
  try {
    const snapshot = value.snapshot, current = runtimeContext(store, project);
    requireCondition(canonical(current.binding) === canonical(snapshot.binding) && current.root === snapshot.root,
      'call_runtime_changed', 'Runtime configuration changed during the call');
    for (const file of [snapshot.interpreter, ...snapshot.subjects]) {
      requireCondition(runtimeSubjectPath(snapshot.root, file.requested, file.kind) === file.path
        && canonical(runtimeExecutableIdentity(file.path)) === canonical(file.identity)
        && await executableHash(file.path) === file.hash,
      'call_runtime_changed', 'An interpreter, provider executable or declared adapter changed during the call');
    }
    requireCondition(executablePath(snapshot.invocation, snapshot.root) === snapshot.interpreter.path,
      'call_runtime_changed', 'The measured interpreter is not the configured invocation');
    return { ...value, status: 'observed', finishedAt: Date.now() };
  } catch (error) {
    return { ...value, status: 'stale', finishedAt: Date.now(), error: error instanceof EngineError ? error.code : 'call_runtime_check_failed' };
  }
}
