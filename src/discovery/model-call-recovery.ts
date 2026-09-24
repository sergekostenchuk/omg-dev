import { spawnSync } from 'node:child_process';
import type { Store, Revision, Write } from '../storage/store.js';
import type { ModelCall, ModelExecution, ProcessIdentity } from '../runtime/model-usage.js';
import type { ProcessResult } from '../runtime/process.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { processStart } from '../runtime/process-identity.js';
import { requireCondition } from '../errors.js';
import { canonical, hashJson } from '../canonical.js';

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const identity = (value: unknown): value is ProcessIdentity => !!value && typeof value === 'object'
  && Number.isSafeInteger((value as ProcessIdentity).pid) && (value as ProcessIdentity).pid > 0
  && typeof (value as ProcessIdentity).started === 'string' && (value as ProcessIdentity).started.length > 0;

/** The owner is captured by the caller before its initial CAS, not in onSpawn. */
export function physicalClaim(): Pick<ModelCall, 'ownerProcess' | 'execution'> {
  const owner = { pid: process.pid, started: processStart(process.pid) };
  requireCondition(identity(owner), 'model_call_identity_missing', 'The execution owner identity is required before dispatch');
  return { ownerProcess: owner, execution: { version: 'model-execution/v1', phase: 'claimed', owner, provider: null } };
}

function executionOf(call: ModelCall): ModelExecution | null {
  if (call.execution === undefined) return null;
  const e = call.execution;
  requireCondition(e && e.version === 'model-execution/v1' && identity(e.owner) && same(e.owner, call.ownerProcess ?? null)
    && (e.phase === 'claimed' ? e.provider === null && call.providerProcess === undefined
      : e.phase === 'authorized' && identity(e.provider) && same({ pid: e.provider.pid, started: e.provider.started }, call.providerProcess ?? null)
        && (e.provider.group === null || e.provider.group === e.provider.pid)),
  'model_call_execution_invalid', 'The physical execution must have a complete era, owner and dispatch phase');
  return e;
}

function currentCall(store: Store, project: string, ref: Ref): Revision<ModelCall> {
  requireCondition(isRef(ref), 'model_call_ref_invalid', 'Recovery needs an exact call reference');
  const call = store.get<ModelCall>(ref.id);
  requireCondition(call?.kind === 'model-call' && call.value.projectId === project && same(reference(call), ref),
    'model_call_foreign', 'Recovery must bind the current call of this project');
  return call;
}

/** Called by runProcess before stdin.end. Failure forbids transfer of the request. */
export function authorizeModelDispatch(store: Store, ref: Ref, pid: number): Revision<ModelCall> {
  const head = store.get<ModelCall>(ref.id);
  requireCondition(head?.kind === 'model-call' && same(reference(head), ref), 'model_call_foreign', 'Dispatch must bind the exact claimed call');
  const e = executionOf(head.value);
  requireCondition(head.value.status === 'running' && e?.phase === 'claimed' && e.owner.pid === process.pid
    && processStart(process.pid) === e.owner.started, 'model_call_dispatch_unowned', 'Only the original live owner may authorize request transfer');
  const provider = { pid, started: processStart(pid), group: process.platform === 'win32' ? null : pid };
  requireCondition(identity(provider), 'model_call_identity_missing', 'Provider identity must be committed before request transfer');
  return store.writeMany<ModelCall>([{ id: head.id, kind: head.kind, expected: head.revision,
    value: { ...head.value, providerProcess: { pid, started: provider.started }, execution: { ...e, phase: 'authorized', provider } } }], [ref])[0]!;
}

export interface ModelRecovery {
  version?: 'model-recovery/v1';
  projectId: string; call: Ref; reason: string; usageKnown: boolean;
  execution?: ModelExecution;
  proof?: { owner: 'gone'; provider: 'not-authorized' | 'gone'; group: 'empty' | 'unknown';
    request: 'not-authorized' | 'unknown'; physical: 'group-terminated' | 'unknown' };
}
export interface PreparedModelRecovery {
  call: Revision<ModelCall>; incident: Revision<ModelRecovery>; writes: Write[]; guards: Ref[];
}

// An empty, successfully observed owned process group proves that the leader's
// surviving children are gone too. A missing leader alone does not prove that.
function requireEmptyProviderGroup(group: number | null): void {
  requireCondition(group !== null && process.platform !== 'win32', 'model_call_process_uncertain',
    'Provider termination is unproven: no observable owned process group');
  const observed = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 5000 });
  requireCondition(!observed.error && observed.status === 0, 'model_call_process_uncertain', 'Provider group observation is unavailable');
  const lines = observed.stdout.trim().split('\n').filter(Boolean);
  requireCondition(lines.every(line => /^\s*\d+\s+\d+\s+\S+\s*$/.test(line)),
    'model_call_process_uncertain', 'Provider group observation could not be interpreted');
  requireCondition(!lines.some(line => { const [, , pgid, state] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)!;
    return Number(pgid) === group && !state!.startsWith('Z'); }),
  'model_call_process_uncertain', 'The original provider group still has live descendants; its termination is unproven');
}

function requireIdentityGone(identity: ProcessIdentity, message: string): void {
  const observed = spawnSync('ps', ['-p', String(identity.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000 });
  requireCondition(!observed.error && (observed.status === 0 || observed.status === 1 && observed.stdout.trim() === '' && observed.stderr.trim() === ''),
    'model_call_process_uncertain', 'Process identity could not be observed; observation failure is not proof of death');
  requireCondition(observed.status !== 0 || observed.stdout.trim() !== identity.started,
    'model_call_still_running', message);
  requireCondition(observed.status !== 0 || observed.stdout.trim().length > 0,
    'model_call_process_uncertain', 'Process observation did not yield its identity');
}

/** No writes here: the producer adds its product transition to these same CAS writes. */
export function prepareModelCallRecovery(store: Store, project: string, ref: Ref): PreparedModelRecovery {
  const call = currentCall(store, project, ref);
  requireCondition(call.value.status === 'running' && call.value.response === null, 'model_call_not_running', 'Only an interrupted call without a receipt needs recovery');
  const owner = call.value.ownerProcess, e = executionOf(call.value);
  requireCondition(identity(owner), 'model_call_identity_missing', 'The legacy call has no provable owner identity; do not guess that its provider stopped');
  if (e) requireIdentityGone(owner, 'The execution owner is still alive');
  else requireCondition(processStart(owner.pid) !== owner.started, 'model_call_still_running', 'The research owner is still alive');
  let proof: ModelRecovery['proof'];
  if (e?.phase === 'claimed') {
    // A child may be waiting on stdin. No authorization means no request was
    // transferred, not that no OS process exists.
    proof = { owner: 'gone', provider: 'not-authorized', group: 'unknown', request: 'not-authorized', physical: 'unknown' };
  } else {
    const provider = call.value.providerProcess;
    requireCondition(identity(provider), 'model_call_identity_missing', 'Provider identity was not saved; its termination cannot be inferred from the owner exit');
    if (e) requireIdentityGone(provider, 'The recorded provider is still alive');
    else requireCondition(processStart(provider.pid) !== provider.started, 'model_call_still_running', 'The recorded provider is still alive');
    if (e) { requireEmptyProviderGroup(e.provider!.group); proof = { owner: 'gone', provider: 'gone', group: 'empty', request: 'unknown', physical: 'group-terminated' }; }
  }
  const value: ModelRecovery = { projectId: project, call: ref,
    reason: e?.phase === 'claimed' ? 'Owner lost before request authorization; supplier existence remains unknown'
      : 'Recorded owner and provider processes no longer exist with their original identities', usageKnown: call.value.usage !== null,
    ...(e ? { version: 'model-recovery/v1' as const, execution: e, proof: proof! } : {}) };
  const incident: Revision<ModelRecovery> = { id: `model-call-recovery:${call.value.requestId}`, kind: 'model-call-recovery', revision: 1, hash: hashJson(value), value };
  return { call, incident, guards: [ref], writes: [
    { id: call.id, kind: call.kind, expected: call.revision, value: { ...call.value, status: 'failed', finishedAt: Date.now(), error: 'process_lost', ...(e ? { recovery: reference(incident) } : {}) } },
    { id: incident.id, kind: incident.kind, expected: 0, value }] };
}

/** Historical proof does not re-observe today's processes. Product fields (OM)
 * are checked by their own producer; the physical call identity stays exact. */
export function readModelCallRecovery(store: Store, project: string, recovered: Ref) {
  requireCondition(isRef(recovered), 'model_call_ref_invalid', 'Recovery history needs an exact reference');
  const record = store.get<ModelCall>(recovered.id, recovered.revision);
  requireCondition(record?.kind === 'model-call' && record.value.projectId === project && same(reference(record), recovered)
    && record.value.status === 'failed' && record.value.error === 'process_lost' && record.value.finishedAt !== null && isRef(record.value.recovery),
  'model_call_recovery_invalid', 'The terminal physical interruption has no exact recovery proof');
  const incident = store.get<ModelRecovery>(record.value.recovery.id, record.value.recovery.revision);
  requireCondition(incident?.kind === 'model-call-recovery' && same(reference(incident), record.value.recovery)
    && incident.value.projectId === project && incident.value.version === 'model-recovery/v1', 'model_call_recovery_invalid', 'Recovery proof is missing or foreign');
  const original = store.get<ModelCall>(incident.value.call.id, incident.value.call.revision);
  requireCondition(original?.kind === 'model-call' && same(reference(original), incident.value.call) && original.id === record.id
    && original.revision + 1 === record.revision && original.value.status === 'running' && original.value.response === null,
  'model_call_recovery_invalid', 'Recovery must follow its exact running state');
  const e = executionOf(original.value), proof = incident.value.proof;
  requireCondition(e && same(e, incident.value.execution) && same(e, record.value.execution)
    && proof && same(proof, e.phase === 'claimed'
      ? { owner: 'gone', provider: 'not-authorized', group: 'unknown', request: 'not-authorized', physical: 'unknown' }
      : { owner: 'gone', provider: 'gone', group: 'empty', request: 'unknown', physical: 'group-terminated' })
    && incident.value.usageKnown === (original.value.usage !== null), 'model_call_recovery_invalid', 'Physical recovery evidence contradicts the dispatch phase');
  const physical = (value: ModelCall) => Object.fromEntries(Object.entries(value)
    .filter(([field]) => !['status', 'finishedAt', 'error', 'recovery', 'om', 'transport'].includes(field)));
  requireCondition(same(physical(original.value), physical(record.value)), 'model_call_recovery_invalid',
    'Recovery changed physical identity, request, accounting, or producer provenance');
  return { record, incident, original, proof };
}

export interface LateModelReceipt {
  version: 'model-late-receipt/v1'; projectId: string; dispatch: Ref; recovered: Ref; incident: Ref;
  evidence: { process: ProcessResult | null; launchError: { code: string; message: string } | null };
}
function lateEvidence(evidence: LateModelReceipt['evidence']) {
  const p = evidence?.process, failure = evidence?.launchError;
  requireCondition(evidence && Object.keys(evidence).sort().join(',') === 'launchError,process'
    && (p !== null && failure === null && p && Object.keys(p).sort().join(',') === 'exitCode,signal,stderr,stdout'
      && (p.exitCode === null || Number.isSafeInteger(p.exitCode)) && (p.signal === null || typeof p.signal === 'string')
      && typeof p.stdout === 'string' && typeof p.stderr === 'string'
      || p === null && failure && Object.keys(failure).sort().join(',') === 'code,message'
        && typeof failure.code === 'string' && failure.code.length > 0 && typeof failure.message === 'string'),
  'model_call_late_receipt_invalid', 'Late evidence must contain one saved physical result or launch error');
}
export function prepareLateModelReceipt(store: Store, project: string, dispatch: Ref, evidence: LateModelReceipt['evidence']) {
  const original = store.get<ModelCall>(dispatch.id, dispatch.revision), head = store.get<ModelCall>(dispatch.id);
  requireCondition(original && same(reference(original), dispatch) && original.value.projectId === project && executionOf(original.value)?.phase === 'authorized'
    && head, 'model_call_late_receipt_invalid', 'Late evidence needs the exact authorized dispatch');
  const recovered = readModelCallRecovery(store, project, reference(head));
  requireCondition(same(reference(recovered.original), dispatch),
  'model_call_late_receipt_invalid', 'Late evidence belongs to another dispatch or has no physical result');
  lateEvidence(evidence);
  const value: LateModelReceipt = { version: 'model-late-receipt/v1', projectId: project, dispatch, recovered: reference(head), incident: reference(recovered.incident), evidence };
  const id = `model-late-receipt:${hashJson({ dispatch })}`, prior = store.get<LateModelReceipt>(id);
  requireCondition(!prior || prior.kind === 'model-late-receipt' && same(prior.value, value), 'model_call_late_receipt_invalid', 'Late receipt identity has conflicting content');
  const record: Revision<LateModelReceipt> = prior ?? { id, kind: 'model-late-receipt', revision: 1, hash: hashJson(value), value };
  return { record, recovered, writes: prior ? [] as Write[] : [{ id, kind: record.kind, expected: 0, value }], guards: [reference(head), reference(recovered.incident)] };
}

export function readLateModelReceipt(store: Store, project: string, recovered: Ref): Revision<LateModelReceipt> | null {
  const recovery = readModelCallRecovery(store, project, recovered), dispatch = reference(recovery.original);
  const record = store.get<LateModelReceipt>(`model-late-receipt:${hashJson({ dispatch })}`);
  if (!record) return null;
  const v = record.value;
  requireCondition(record.kind === 'model-late-receipt' && record.revision === 1 && v.version === 'model-late-receipt/v1'
    && v.projectId === project && same(v.dispatch, dispatch) && same(v.recovered, recovered) && same(v.incident, reference(recovery.incident))
    && executionOf(recovery.original.value)?.phase === 'authorized',
  'model_call_late_receipt_invalid', 'Late evidence does not belong to the exact recovered dispatch');
  lateEvidence(v.evidence);
  return record;
}

/** Legacy callers retain their original two-identity recovery. OM routes this
 * preparation through its product transition instead of calling this writer. */
export function recoverModelCall(store: Store, project: string, ref: Ref) {
  const prepared = prepareModelCallRecovery(store, project, ref);
  requireCondition(!Object.hasOwn(prepared.call.value, 'om') && !Object.hasOwn(prepared.call.value, 'transport'),
    'model_call_recovery_producer_required', 'OM physical recovery must include its product transition in the same transaction');
  return store.writeMany<ModelCall>(prepared.writes, prepared.guards)[0]!;
}
