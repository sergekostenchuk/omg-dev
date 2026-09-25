import { consolidationInput } from './conclusion-consolidation.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, realpathSync } from 'node:fs';
import { constants as systemConstants } from 'node:os';
import type { Store, Revision, Write, TransactionGuard } from '../storage/store.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { RoleBinding } from '../runtime/environment.js';
import { Environments, uniqueTransactionGuards } from '../runtime/environment.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { RecoverableContextSession } from './context-recovery.js';
import { readerPilot, pilotEnvironment } from './reader-pilot.js';
import { archivedContext } from './working-context.js';
import { contextWorkspace } from './context-workspace.js';
import { canonical, digest, hashJson } from '../canonical.js';
import { reference, isRef, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import { EngineError, requireCondition } from '../errors.js';
import { Evidence, type Source } from '../evidence/evidence.js';
import { processStart } from '../runtime/process-identity.js';

export interface ResponseRecovery {
  projectId: string; declaredBy: string; call: Ref; request: Ref; response: Ref; archive: Ref;
  sessionBefore: Ref; sessionAfter: Ref; state: 'applied';
}
interface RecoveryScope {
  id: string; project: string; draft: string; question: string; purpose: string; role: RoleBinding;
  profile: Ref | null; session: Ref; archive: Ref; subject: Record<string, any>; payload: unknown;
  origin: Omit<ResponseRecovery, 'sessionAfter' | 'state'>; guards: Ref[]; delivered: boolean; applied: boolean;
}
const current = new AsyncLocalStorage<RecoveryScope>();
const boundary = () => new EngineError('response_recovery_boundary', 'The selected paid response was consumed; no next provider call is allowed during recovery');

/** Recovery is an explicit operator command. Ordinary research has no replay
 * permission from this scope and follows its normal dispatch path. */
export function recoveredResponseBoundary(): void { if (current.getStore()?.applied) throw boundary(); }
export function isResponseRecovery(): boolean { return current.getStore() !== undefined; }
export function markApplicationResponseRecovered(call: Ref, session: Ref): void {
  const scope = current.getStore(); if (!scope) return;
  requireCondition(isRef(call) && isRef(session) && canonical(call) === canonical(scope.origin.call)
    && canonical(session) === canonical(scope.session), 'response_recovery_context_changed',
  'An application may consume only the exact paid response selected by the operator');
  scope.delivered = true;
}
export function recoveryDispatchBoundary(): void { if (current.getStore()?.delivered) throw boundary(); }
export function recoveryConsolidationMode(): boolean | undefined {
  const scope = current.getStore(); return scope ? scope.subject.dispatchMode === 'consolidation' : undefined;
}
export function recoveryAssessmentSessionId(computed: string): string {
  const scope = current.getStore(); return scope?.purpose === 'assessor' ? scope.session.id : computed;
}
export function operatorReplayedResponse(role: RoleBinding, input: string,
  audit?: { draftId: string; questionId?: string; purpose: string; session?: Ref; pilot?: Revision<import('./reader-pilot.js').ReaderPilot> }) {
  const scope = current.getStore(); if (!scope) return null;
  const request = JSON.parse(input);
  requireCondition(audit && audit.draftId === scope.draft && audit.questionId === scope.question && audit.purpose === scope.purpose
    && canonical(audit.session ?? null) === canonical(scope.session) && canonical(role) === canonical(scope.role)
    && canonical(audit.pilot ? reference(audit.pilot) : null) === canonical(scope.profile)
    && canonical(request.subject?.working?.archive ?? null) === canonical(scope.archive),
  'response_recovery_context_changed', 'Recovery must reach the exact original consumer context, role, profile and session');
  scope.delivered = true;
  return { research: scope.payload, subject: scope.subject };
}

/** Commit the ordinary consumer's state and its recovery receipt together.
 * A crash cannot advance a cursor without preserving the applied identity. */
export function recoverySessionWrites(write: Write): { writes: Write[]; guards: Ref[] } {
  const scope = current.getStore(); if (!scope) return { writes: [], guards: [] };
  requireCondition(scope.delivered && !scope.applied && write.id === scope.session.id && write.expected === scope.session.revision,
    'response_recovery_context_changed', 'An operator replay may update only its exact unconsumed session');
  const value = write.value as RecoverableContextSession;
  requireCondition(!value.workspace?.blocked, 'response_recovery_not_applied', 'An invalid contextual read cannot count as recovered material');
  const sessionAfter = { id: write.id, revision: write.expected + 1, hash: hashJson(write.value) };
  return { writes: [{ id: scope.id, kind: 'research-response-recovery', expected: 0,
    value: { ...scope.origin, sessionAfter, state: 'applied' } satisfies ResponseRecovery }], guards: scope.guards };
}
export function markRecoveredSessionWritten(additions: { writes: Write[] }): void {
  if (additions.writes.length) current.getStore()!.applied = true;
}

function responseSessionBinding(session: Revision<RecoverableContextSession>) {
  const binding = session.value.binding;
  requireCondition(binding && isRef(binding.draft) && isRef(binding.question) && isRef(binding.environment)
    && Array.isArray(binding.inputs) && binding.inputs.every(isRef) && Array.isArray(session.value['notes'])
    && Number.isSafeInteger(session.value['offset']) && Number(session.value['offset']) >= 0,
    'response_recovery_binding_missing', 'The session must retain its complete research binding');
  return binding;
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The saved session producer selects the contract; a missing response field
 * cannot turn a new assessment into historical legacy execution. */
export function assessmentSessionEra(session: Revision<RecoverableContextSession>): boolean {
  requireCondition(isRef(session) && object(session.value), 'response_recovery_session_stale', 'An exact saved consumer session is required');
  if (session.kind !== 'assessment-session') return false;
  const current = session.id.startsWith('assessment-session:v1:');
  requireCondition(current
    ? session.value['contract'] === 'assessment-application/v1'
      && typeof session.value['application'] === 'string' && session.value['application'].length > 0
    : !Object.hasOwn(session.value, 'contract'),
  'response_recovery_session_stale', 'The assessment session must retain its producer contract and application identity');
  return current;
}

interface AssessmentReadEntry { id: string; revision: number | null; ref: Ref | null; absence?: { head: Ref | null } }
type AssessmentFileObservation = { kind: 'bytes'; path: string; bytes: string }
  | { kind: 'relocated'; path: string }
  | { kind: 'unavailable'; operation: 'realpath' | 'read'; path: string | null; code: string };
interface AssessmentFileSnapshot { source: Ref; observation: AssessmentFileObservation }
export interface AssessmentReadProof {
  contract: 'assessment-read/v1'; reads: AssessmentReadEntry[]; files: AssessmentFileSnapshot[];
}

/** One evaluation's semantic input view. The local owner-document projection
 * substitutes a captured filesystem observation for Evidence's live probe; it
 * is never a saved Source and must never be registered as transparent in S1. */
export function assessmentReadView(store: Store, savedProof?: AssessmentReadProof | null): {
  store: Store; proof: AssessmentReadProof; guards: TransactionGuard[]; finish(): AssessmentReadProof;
} {
  let invalid: EngineError | null = null;
  function fail(message: string): never {
    invalid ??= new EngineError('research_context_read_proof_invalid', message);
    throw invalid;
  }
  const shape = (value: unknown, keys: string[]): value is Record<string, any> => object(value)
    && Object.keys(value).sort().join(',') === keys.sort().join(',');
  const ref = (value: unknown): value is Ref => shape(value, ['id', 'revision', 'hash']) && isRef(value);
  const knownError = (code: unknown): code is string => typeof code === 'string' && code.length > 0
    && Object.hasOwn(systemConstants.errno, code);
  function validate(proof: unknown): asserts proof is AssessmentReadProof {
    if (!shape(proof, ['contract', 'reads', 'files']) || proof.contract !== 'assessment-read/v1'
      || !Array.isArray(proof.reads) || !Array.isArray(proof.files)) fail('The assessment read proof must retain its complete declared shape');
    for (const entry of proof.reads) {
      if (!object(entry) || !shape(entry, entry.revision !== null && entry.ref === null
        ? ['id', 'revision', 'ref', 'absence'] : ['id', 'revision', 'ref']) || typeof entry.id !== 'string' || entry.id.length === 0
        || !(entry.revision === null || Number.isSafeInteger(entry.revision) && entry.revision > 0)
        || !(entry.ref === null || ref(entry.ref) && entry.ref.id === entry.id
          && (entry.revision === null || entry.ref.revision === entry.revision))) fail('A captured get must retain its exact selector and result');
      if (entry.revision !== null && entry.ref === null && (!shape(entry.absence, ['head'])
        || !(entry.absence.head === null || ref(entry.absence.head) && entry.absence.head.id === entry.id
          && entry.absence.head.revision < entry.revision))) fail('A missing exact revision must retain the prior append-only head');
    }
    const sources = new Set<string>();
    for (const file of proof.files) {
      if (!shape(file, ['source', 'observation']) || !ref(file.source)
        || !proof.reads.some((entry: AssessmentReadEntry) => entry.ref && canonical(entry.ref) === canonical(file.source)))
        fail('A file snapshot must belong to an exact Source read in this evaluation');
      const key = canonical(file.source);
      if (sources.has(key)) fail('A file source may have only one snapshot per evaluation');
      sources.add(key);
      const observation = file.observation;
      if (!object(observation)) fail('A file snapshot needs an explicit observed outcome');
      if (observation.kind === 'bytes') {
        if (!shape(observation, ['kind', 'path', 'bytes']) || typeof observation.path !== 'string' || observation.path.length === 0
          || typeof observation.bytes !== 'string' || Buffer.from(observation.bytes, 'base64').toString('base64') !== observation.bytes)
          fail('File bytes must retain their resolved path and canonical base64 encoding');
      } else if (observation.kind === 'relocated') {
        if (!shape(observation, ['kind', 'path']) || typeof observation.path !== 'string' || observation.path.length === 0)
          fail('A relocated source must retain its resolved path');
      } else if (observation.kind === 'unavailable') {
        if (!shape(observation, ['kind', 'operation', 'path', 'code']) || !knownError(observation.code)
          || !(observation.operation === 'realpath' && observation.path === null
            || observation.operation === 'read' && typeof observation.path === 'string' && observation.path.length > 0))
          fail('An unavailable file must retain the actual filesystem operation and errno');
      } else fail('The file snapshot has an unknown observed outcome');
    }
  }
  if (!store || typeof store.get !== 'function') fail('An assessment read view needs a readable Store');
  const replay = savedProof !== undefined && savedProof !== null;
  let proof: AssessmentReadProof;
  if (replay) {
    validate(savedProof);
    proof = JSON.parse(canonical(savedProof)) as AssessmentReadProof;
  } else proof = { contract: 'assessment-read/v1', reads: [], files: [] };
  const guards: TransactionGuard[] = [], usedFiles = new Set<string>();
  let position = 0, finished = false;
  const filesystem = (source: Ref, value: Source): AssessmentFileSnapshot => {
    const key = canonical(source);
    let snapshot = proof.files.find(file => canonical(file.source) === key);
    if (!snapshot && replay) fail('The captured file snapshot required by this Source is missing');
    if (!snapshot) {
      let observation: AssessmentFileObservation, path: string;
      try { path = realpathSync(value.origin.location); }
      catch (error) {
        const code = object(error) ? error.code : undefined;
        if (!knownError(code)) fail('The filesystem did not provide an attributable errno');
        snapshot = { source, observation: { kind: 'unavailable', operation: 'realpath', path: null, code } };
        proof.files.push(snapshot); usedFiles.add(key); return snapshot;
      }
      if (path !== value.origin.location) observation = { kind: 'relocated', path };
      else {
        try { observation = { kind: 'bytes', path, bytes: readFileSync(path).toString('base64') }; }
        catch (error) {
          const code = object(error) ? error.code : undefined;
          if (!knownError(code)) fail('The filesystem did not provide an attributable errno');
          observation = { kind: 'unavailable', operation: 'read', path, code };
        }
      }
      snapshot = { source, observation }; proof.files.push(snapshot);
    }
    usedFiles.add(key);
    return snapshot;
  };
  const get = <T>(id: string, revision?: number): Revision<T> | null => {
    if (invalid) throw invalid;
    if (finished) fail('An assessment read view cannot escape its finished evaluation');
    if (typeof id !== 'string' || id.length === 0 || revision !== undefined && (!Number.isSafeInteger(revision) || revision <= 0))
      fail('An assessment read must name a valid Store selector');
    let entry: AssessmentReadEntry, record: Revision<T> | null;
    if (replay) {
      const saved = proof.reads[position];
      if (!saved || saved.id !== id || saved.revision !== (revision ?? null)) fail('The historical evaluation read a different input sequence');
      entry = saved;
      try { record = entry.ref ? store.get<T>(entry.ref.id, entry.ref.revision) : null; }
      catch { fail('The exact captured Store revision could not be read'); }
      if (entry.ref && (!record || canonical(reference(record)) !== canonical(entry.ref))) fail('An exact captured revision is missing or foreign');
      if (entry.absence?.head) {
        const expected = entry.absence.head;
        let head: Revision | null;
        try { head = store.get(expected.id, expected.revision); }
        catch { fail('The exact head proving the missing revision could not be read'); }
        if (!head || canonical(reference(head)) !== canonical(expected) || hashJson(head.value) !== expected.hash)
          fail('The captured head does not prove the missing historical revision');
      }
    } else {
      try { record = store.get<T>(id, revision); }
      catch { fail('The assessment Store input could not be captured exactly'); }
      entry = { id, revision: revision ?? null, ref: record ? reference(record) : null };
      if (!record && revision !== undefined) {
        let head: Revision | null;
        try {
          head = store.get(id);
          // Capture the head before confirming absence. A concurrent append
          // either supplies this immutable revision or invalidates its guard.
          record = store.get<T>(id, revision);
        } catch { fail('The missing exact revision could not be captured with its head'); }
        if (record) entry.ref = reference(record);
        else {
          if (head && (head.id !== id || !ref(reference(head)) || hashJson(head.value) !== head.hash || head.revision >= revision))
            fail('A missing exact revision cannot precede an existing append-only head');
          entry.absence = { head: head ? reference(head) : null };
        }
      }
      proof.reads.push(entry);
    }
    position++;
    if (record) {
      let matches = false;
      try { matches = record.id === id && (revision === undefined || record.revision === revision)
        && ref(reference(record)) && hashJson(record.value) === record.hash; }
      catch { fail('The captured Store result is not a complete exact revision'); }
      if (!matches) fail('A captured Store result does not match its exact saved bytes');
    }
    if (revision === undefined) guards.push(entry.ref ?? { id, absent: true });
    else if (entry.ref === null) guards.push(entry.absence!.head ?? { id, absent: true });
    // Evidence.observe probes the Source head before checking the filesystem.
    // Exact archived reads retain the original Source, including /origin; the
    // local projection must not change any addressable historical value.
    if (revision === undefined && record?.kind === 'source' && object(record.value) && object(record.value.origin) && record.value.origin.kind === 'file') {
      const source = record.value as unknown as Source;
      if (typeof source.content !== 'string' || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256)
        || typeof source.origin.location !== 'string' || source.origin.location.length === 0) fail('A captured file Source is malformed');
      const snapshot = filesystem(reference(record), source), observed = snapshot.observation;
      if (observed.kind === 'relocated' && observed.path === source.origin.location
        || observed.kind === 'bytes' && observed.path !== source.origin.location
        || observed.kind === 'unavailable' && observed.operation === 'read' && observed.path !== source.origin.location)
        fail('The file snapshot contradicts its exact Source path');
      // This is the same predicate as sourceIsCurrent, evaluated from captured
      // external bytes instead of consulting today's filesystem during replay.
      if (digest(source.content) !== source.sha256 || observed.kind !== 'bytes'
        || digest(Buffer.from(observed.bytes, 'base64')) !== source.sha256)
        throw new EngineError('source_stale', 'The captured source file changed or could not be read during assessment');
      return { ...record, value: { ...source, origin: { ...source.origin, kind: 'owner-document' } } as T };
    }
    return record;
  };
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get') return get;
    const value = Reflect.get(target, key, target);
    if (typeof value === 'function') return () => fail('Assessment input views support only captured get reads');
    return value;
  } });
  return { store: view, proof, guards, finish() {
    if (invalid) throw invalid;
    validate(proof);
    if (position !== proof.reads.length || usedFiles.size !== proof.files.length)
      fail('The historical evaluation must consume the complete read and filesystem proof');
    guards.splice(0, guards.length, ...uniqueTransactionGuards(guards));
    finished = true; return proof;
  } };
}

interface ResearchExecutionContext {
  call: Revision<ModelCall>; request: Ref; response: Ref; archive: Ref;
  body: Record<string, any>; subject: Record<string, any>; prompt: string; guards: Ref[];
}
export type ResearchExecution = ResearchExecutionContext & (
  { kind: 'response'; payload: unknown } | { kind: 'provider-failed' });

/** The receipt records runProcess's close result, not an interpretation of its
 * status label. Only this new producer era can prove an ordinary failed retry. */
function assessmentExecution(store: Store, call: Revision<ModelCall>, value: Record<string, any>): Ref[] {
  const receipt = value.assessmentExecution;
  const fields = (record: Record<string, any>, names: string[]) => Object.keys(record).sort().join(',') === names.sort().join(',');
  const identity = (record: unknown): record is { pid: number; started: string } => object(record)
    && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.started === 'string' && record.started.length > 0;
  requireCondition(object(receipt) && fields(receipt, ['contract', 'call', 'dispatch', 'process'])
    && receipt.contract === 'assessment-execution/v1' && isRef(receipt.call) && isRef(receipt.dispatch)
    && object(receipt.process) && fields(receipt.process, ['exitCode', 'signal', 'stderr'])
    && (receipt.process.exitCode === null || Number.isSafeInteger(receipt.process.exitCode) && receipt.process.exitCode >= 0)
    && (receipt.process.signal === null || typeof receipt.process.signal === 'string' && receipt.process.signal.length > 0)
    && typeof receipt.process.stderr === 'string',
  'response_recovery_execution_invalid', 'The saved physical outcome needs its complete process receipt');
  const claim = store.get<ModelCall>(receipt.call.id, receipt.call.revision);
  const dispatch = store.get<ModelCall>(receipt.dispatch.id, receipt.dispatch.revision);
  requireCondition(claim?.kind === 'model-call' && dispatch?.kind === 'model-call' && object(claim.value) && object(dispatch.value)
    && canonical(reference(claim)) === canonical(receipt.call) && canonical(reference(dispatch)) === canonical(receipt.dispatch)
    && hashJson(claim.value) === claim.hash && hashJson(dispatch.value) === dispatch.hash
    && claim.id === call.id && dispatch.id === call.id && claim.revision === 1 && dispatch.revision === claim.revision + 1
    && call.revision > dispatch.revision && claim.value.status === 'running' && claim.value.finishedAt === null
    && claim.value.response === null && claim.value.error === null && isRef((claim.value as ModelCall & { assessmentApplication?: Ref }).assessmentApplication),
  'response_recovery_execution_invalid', 'The physical receipt must name the original assessment claim and authorization');
  const before = claim.value.execution, authorized = dispatch.value.execution;
  requireCondition(before?.version === 'model-execution/v1' && before.phase === 'claimed' && identity(before.owner)
    && identity(claim.value.ownerProcess) && canonical(before.owner) === canonical(claim.value.ownerProcess)
    && before.provider === null && claim.value.providerProcess === undefined
    && authorized?.version === 'model-execution/v1' && authorized.phase === 'authorized' && identity(authorized.provider)
    && (authorized.provider.group === null || authorized.provider.group === authorized.provider.pid)
    && identity(authorized.owner) && canonical(authorized.owner) === canonical(before.owner) && identity(dispatch.value.providerProcess)
    && canonical(dispatch.value.providerProcess) === canonical({ pid: authorized.provider.pid, started: authorized.provider.started }),
  'response_recovery_execution_invalid', 'The physical receipt must follow an authorized assessment dispatch');
  const without = (record: ModelCall, excluded: string[]) => Object.fromEntries(Object.entries(record).filter(([key]) => !excluded.includes(key)));
  requireCondition(canonical(without(claim.value, ['execution', 'providerProcess'])) === canonical(without(dispatch.value, ['execution', 'providerProcess']))
    && canonical(without(dispatch.value, ['status', 'finishedAt', 'response', 'usage', 'usageSource', 'error', 'confirmed', 'runtime']))
      === canonical(without(call.value, ['status', 'finishedAt', 'response', 'usage', 'usageSource', 'error', 'confirmed', 'runtime']))
    && Number.isSafeInteger(call.value.finishedAt) && Number(call.value.finishedAt) >= call.value.startedAt,
  'response_recovery_execution_invalid', 'The terminal call changed its authorized physical identity');
  requireCondition(call.value.status === 'succeeded'
    ? call.value.error === null && receipt.process.exitCode === 0 && receipt.process.signal === null
    : call.value.status === 'failed',
  'response_recovery_execution_invalid', 'The saved status contradicts the physical process outcome');
  return [receipt.call, receipt.dispatch];
}

/** Read only the exact physical outcome and its archived consumer state. Current
 * admission and operator authority are checked separately by the caller. */
function researchExecution(store: Store, project: string, callRef: Ref,
  session: Revision<RecoverableContextSession>, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  role: RoleBinding, profile: Ref | null, onlyResponse: boolean): ResearchExecution {
  requireCondition(store && typeof store.get === 'function' && typeof project === 'string' && project.length > 0
    && isRef(callRef) && isRef(session) && isRef(draft) && isRef(question) && object(role)
    && typeof role.actor === 'string' && typeof role.model === 'string' && typeof role.effort === 'string'
    && object(role.command) && typeof role.command.executable === 'string' && Array.isArray(role.command.args)
    && (profile === null || isRef(profile)), 'response_recovery_invalid', 'A saved response needs exact physical and consumer references');
  const exact = <T>(supplied: Revision<T>, kinds: string[], code: string): Revision<T> => {
    const saved = store.get<T>(supplied.id, supplied.revision);
    requireCondition(saved && kinds.includes(saved.kind) && saved.hash === supplied.hash && object(saved.value)
      && canonical(saved) === canonical(supplied), code, 'The supplied consumer revision must match its exact saved state');
    return saved;
  };
  session = exact(session, ['synthesis-session', 'assessment-session'], 'response_recovery_session_stale');
  const applicationEra = assessmentSessionEra(session);
  draft = exact(draft, ['discovery-draft'], 'response_recovery_binding_stale');
  question = exact(question, ['question'], 'response_recovery_binding_stale');
  const binding = responseSessionBinding(session);
  const inputs = uniqueRefs([binding.draft, binding.question, binding.environment, ...binding.inputs]);
  requireCondition(session.value.projectId === project && draft.value.projectId === project && question.value.projectId === project
    && canonical(reference(draft)) === canonical(binding.draft) && canonical(reference(question)) === canonical(binding.question)
    && question.value.draftId === draft.id && Array.isArray(draft.value.questions) && draft.value.questions.includes(question.id)
    && canonical(draft.value.inputs) === canonical(binding.inputs) && inputs.every(ref => {
      const saved = store.get(ref.id, ref.revision); return saved && saved.hash === ref.hash;
    }), 'response_recovery_binding_stale', 'The archived session must retain its exact research binding');
  const synthesis = session.kind === 'synthesis-session', purpose = synthesis ? 'analyst' : 'assessor';
  const call = store.get<ModelCall>(callRef.id, callRef.revision);
  requireCondition(call?.kind === 'model-call' && object(call.value) && canonical(reference(call)) === canonical(callRef)
    && (!onlyResponse || call.value.status === 'succeeded') && hashJson(call.value) === call.hash
    && call.value.projectId === project && call.value.draftId === draft.id && call.value.questionId === question.id
    && call.value.purpose === purpose && object(call.value.requested) && canonical(call.value.requested) === canonical(role)
    && canonical(call.value.profile ?? null) === canonical(profile),
  'response_recovery_call_foreign', 'The succeeded call must belong to this exact consumer, profile and role');
  requireCondition(object(call.value.request) && object(call.value.response) && object(call.value.packet),
    'response_recovery_wire_missing', 'The complete paid request, response and context archive must exist');
  const requestRef = call.value.request.record, responseRef = call.value.response.record, archiveRef = call.value.packet.archive;
  requireCondition(isRef(requestRef) && isRef(responseRef) && isRef(archiveRef), 'response_recovery_wire_missing', 'The complete paid request, response and context archive must exist');
  const read = (ref: Ref, kind: string) => {
    const record = store.get<Record<string, any>>(ref.id, ref.revision);
    requireCondition(record?.kind === kind && canonical(reference(record)) === canonical(ref) && object(record.value)
      && hashJson(record.value) === record.hash && record.value.projectId === project
      && record.value.draftId === draft.id && typeof record.value.text === 'string', 'response_recovery_wire_invalid', 'A saved wire identity is missing or foreign');
    return record.value;
  };
  const requestValue = read(requestRef, 'model-request'), responseValue = read(responseRef, 'model-response');
  const requestText = requestValue.text as string, responseText = responseValue.text as string;
  requireCondition(digest(requestText) === call.value.request.hash && requestText.length === call.value.request.chars
    && Buffer.byteLength(requestText) === call.value.request.bytes && responseText.length === call.value.response!.chars
    && Buffer.byteLength(responseText) === call.value.response!.bytes, 'response_recovery_wire_invalid', 'Recovery cannot truncate or repair paid wire bytes');
  let request: Record<string, any>, response: unknown;
  try { request = JSON.parse(requestText); }
  catch { throw new EngineError('response_recovery_wire_invalid', 'Both saved envelopes must be complete JSON'); }
  try { response = JSON.parse(responseText); }
  catch { if (onlyResponse) throw new EngineError('response_recovery_wire_invalid', 'Both saved envelopes must be complete JSON'); }
  requireCondition(object(request) && object(request.subject) && typeof request.prompt === 'string'
    && request.protocol === 'omg-agent/v1' && request.mode === 'research' && request.requestId === call.value.requestId
    && (!onlyResponse || object(response) && response.protocol === request.protocol && response.requestId === request.requestId && Object.hasOwn(response, 'research'))
    && request.model === role.model && request.effort === role.effort && (request.speed ?? 'inherited') === (role.speed ?? 'inherited')
    && canonical(request.subject?.working?.archive ?? null) === canonical(archiveRef),
  'response_recovery_wire_foreign', 'The raw envelopes must match the selected paid call');
  const savedArchive = store.get<Record<string, unknown>>(archiveRef.id, archiveRef.revision);
  requireCondition(savedArchive?.kind === 'research-context' && savedArchive.hash === archiveRef.hash && object(savedArchive.value)
    && isRef(savedArchive.value['draft']) && isRef(savedArchive.value['question']) && object(savedArchive.value['body']),
  'context_reference_foreign', 'The context archive must retain exact research references and a complete body');
  // archivedContext shares its existing archive formula. Only its unversioned
  // question lookup is pinned here; this is a separate semantic view, not a
  // transparent Store wrapper or permission to read the current question.
  const historical = { get: <T>(id: string, revision?: number): Revision<T> | null => {
    if (revision === undefined) {
      requireCondition(id === question.id, 'context_reference_foreign', 'Historical response reads must name exact research revisions');
      return question as Revision<T>;
    }
    return store.get<T>(id, revision);
  } } as Store;
  const archive = archivedContext(historical, draft, archiveRef), body = archive.body as Record<string, any>;
  const savedWorkspace = session.value.workspace;
  requireCondition(!savedWorkspace || object(savedWorkspace) && Array.isArray(savedWorkspace.entries)
    && savedWorkspace.entries.every(entry => object(entry) && object(entry.result)),
  'research_context_invalid', 'Saved context workspace is invalid');
  const workspace = contextWorkspace(session.value.workspace, session.value['focus']);
  requireCondition(synthesis ? Array.isArray(body.synthesisMaterials) : Array.isArray(body.observations) && Object.hasOwn(body, 'value'),
    'response_recovery_context_stale', 'Recovery needs the actual archived materials or candidate and observations');
  const state = synthesis ? { offset: session.value['offset'], materialOffset: session.value['materialOffset'] ?? 0 }
    : { offset: session.value['offset'], candidateOffset: session.value['candidateOffset'] ?? 0, total: JSON.stringify(body.observations).length };
  requireCondition(canonical(archive.draft) === canonical(binding.draft) && canonical(archive.question) === canonical(binding.question)
    && body[synthesis ? 'synthesisSession' : 'assessmentSession'] === session.id
    && object(body[synthesis ? 'synthesisState' : 'assessmentState']) && Array.isArray(body[synthesis ? 'synthesisNotes' : 'assessmentNotes'])
    && canonical(body[synthesis ? 'synthesisState' : 'assessmentState']) === canonical(state)
    && canonical(body[synthesis ? 'synthesisNotes' : 'assessmentNotes']) === canonical(session.value['notes'])
    && canonical(body.contextWorkspace ?? []) === canonical(workspace.entries.map(entry => entry.result))
    && !workspace.blocked,
  'response_recovery_cursor_stale', 'The archived cursor, notes, materials context or workspace was already changed');
  if (synthesis && body.dispatchMode === 'consolidation') {
    requireCondition(object(body.consolidation) && Number.isSafeInteger(body.consolidation.targetChars) && body.consolidation.targetChars > 0
      && request.subject.dispatchMode === 'consolidation'
      && canonical(request.subject.synthesisState) === canonical(state)
      && request.subject.synthesisSession === session.id
      && canonical(request.subject.question) === canonical({ id: question.id, ...question.value.spec })
      && canonical(request.subject.consolidation) === canonical({...consolidationInput(body.synthesisNotes, body.consolidation.targetChars, body.consolidation.format === 2 ? 2 : 1),
        ...(body.consolidation.tightening?{tightening:body.consolidation.tightening}:{})})
      && !request.subject.synthesisPage && !request.subject.materialPage && !request.subject.selectedContext && !request.subject.readings,
    'response_recovery_page_foreign', 'The consolidation must contain exactly the saved notes and contract, without claiming material progress');
  } else if (synthesis) {
    const page = request.subject.synthesisPage, materials = body.synthesisMaterials, fragment = request.subject.materialPage;
    requireCondition(Array.isArray(materials) && materials.every(object) && object(page) && page.offset === state.offset && Number.isSafeInteger(page.end)
      && page.end >= page.offset && page.end <= materials.length && page.total === materials.length
      && page.complete === (page.end === materials.length), 'response_recovery_page_foreign', 'The saved material page has a foreign cursor');
    if (fragment) {
      const encoded = JSON.stringify(materials[page.offset]?.value);
      requireCondition(typeof encoded === 'string' && object(fragment) && fragment.encoding === 'json-string-fragment'
        && fragment.index === page.offset && fragment.offset === (session.value['materialOffset'] ?? 0)
        && Number.isSafeInteger(fragment.end) && fragment.end > fragment.offset && fragment.end <= encoded.length
        && fragment.total === encoded.length && fragment.text === encoded.slice(fragment.offset, fragment.end)
        && canonical(fragment.original) === canonical({ record: archiveRef, pointer: `/body/synthesisMaterials/${page.offset}/value` })
        && (page.nextMaterialOffset ?? 0) === (fragment.end === encoded.length ? 0 : fragment.end)
        && page.end === (fragment.end === encoded.length ? page.offset + 1 : page.offset),
      'response_recovery_page_foreign', 'The recovered cursor must follow the exact original fragment');
    } else {
      const supplied = materials.slice(page.offset, page.end);
      requireCondition((session.value['materialOffset'] ?? 0) === 0 && (page.nextMaterialOffset ?? 0) === 0
        && canonical(request.subject.selectedContext ?? []) === canonical(supplied.filter((item: any) => item.kind !== 'reader').map((item: any) => item.value))
        && canonical(request.subject.readings ?? []) === canonical(supplied.filter((item: any) => item.kind === 'reader').map((item: any) => item.value)),
      'response_recovery_page_foreign', 'The complete material page must match its archived values');
    }
  } else {
    const evidence = request.subject.evidencePage, candidate = request.subject.candidatePage;
    const evidenceText = JSON.stringify(body.observations), candidateText = JSON.stringify(body.value);
    requireCondition(object(evidence) && object(candidate) && evidence.offset === session.value['offset'] && evidence.total === evidenceText.length
      && evidence.end >= evidence.offset && evidence.end <= evidence.total && evidence.complete === (evidence.end === evidence.total)
      && candidate.total === candidateText.length && (candidate.offset === (session.value['candidateOffset'] ?? 0) || candidate.offset === 0 && candidate.complete)
      && candidate.end >= candidate.offset && candidate.end <= candidate.total && candidate.complete === (candidate.end === candidate.total),
    'response_recovery_page_foreign', 'The assessment must retain both original cursors');
    requireCondition((evidence.text === undefined ? canonical(request.subject.observations) === canonical(body.observations)
      : evidence.text === evidenceText.slice(evidence.offset, evidence.end))
      && (candidate.encoding === 'json-string-fragment' ? candidate.text === candidateText.slice(candidate.offset, candidate.end)
        : canonical(request.subject.value) === canonical(body.value)),
    'response_recovery_page_foreign', 'Ambiguous serialized page order cannot be silently reconstructed');
  }
  const linked = object(response) && response.protocol === request.protocol && response.requestId === request.requestId
    && Object.hasOwn(response, 'research');
  requireCondition(!object(response) || !['protocol', 'requestId', 'research'].some(key => Object.hasOwn(response, key)) || linked,
    'response_recovery_wire_foreign', 'A foreign or incomplete research envelope is not evidence of an absent response');
  const physicalProof = applicationEra ? assessmentExecution(store, call, responseValue) : [];
  const result: ResearchExecutionContext = { call, request: requestRef, response: responseRef, archive: archiveRef, body,
    subject: request.subject as Record<string, any>, prompt: request.prompt as string,
    // Claim and authorization are immutable ancestors of the guarded terminal
    // call, not simultaneous current heads to put into writeMany's guards.
    guards: uniqueRefs([reference(session), callRef, requestRef, responseRef, archiveRef, ...inputs, ...(profile ? [profile] : [])]) };
  if (linked) {
    // Presence, not payload validity, distinguishes a received answer. Even a
    // null or malformed research value belongs to the application transition.
    requireCondition(call.value.status === 'succeeded' && call.value.error === null,
      'response_recovery_execution_invalid', 'A linked research response contradicts the saved failed or running outcome');
    return { kind: 'response', ...result, payload: (response as Record<string, unknown>)['research'] };
  }
  if (call.value.status === 'succeeded') throw new EngineError(object(response) ? 'response_recovery_wire_foreign' : 'response_recovery_wire_invalid',
    'The succeeded physical call must retain its own research response');
  requireCondition(call.value.status === 'failed' && call.value.error === 'research_provider_failed' && physicalProof.length > 0
    && Number.isSafeInteger(responseValue.assessmentExecution.process.exitCode) && responseValue.assessmentExecution.process.exitCode > 0
    && responseValue.assessmentExecution.process.signal === null,
  'response_recovery_execution_invalid', 'Only a proven completed provider failure without a linked research response permits retry');
  return { kind: 'provider-failed', ...result };
}

export function readResearchExecution(store: Store, project: string, callRef: Ref,
  session: Revision<RecoverableContextSession>, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  role: RoleBinding, profile: Ref | null): ResearchExecution {
  return researchExecution(store, project, callRef, session, draft, question, role, profile, false);
}

/** The operator's original succeeded-response contract and DTO stay exact. */
export function readResearchResponse(store: Store, project: string, callRef: Ref,
  session: Revision<RecoverableContextSession>, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  role: RoleBinding, profile: Ref | null) {
  const result = researchExecution(store, project, callRef, session, draft, question, role, profile, true);
  requireCondition(result.kind === 'response', 'response_recovery_call_foreign', 'The selected call has no succeeded research response');
  return { call: result.call, request: result.request, response: result.response, archive: result.archive, body: result.body,
    subject: result.subject, payload: result.payload, prompt: result.prompt, guards: result.guards };
}

/** Reprocess one saved succeeded response through the ordinary synthesis or
 * assessment consumer, stopping before any additional paid request. */
export async function recoverResearchResponse(store: Store, environments: Environments, project: string,
  callRef: Ref, sessionRef: Ref, declaredBy: string): Promise<Revision<ResponseRecovery>> {
  requireCondition(!current.getStore() && isRef(callRef) && isRef(sessionRef) && typeof declaredBy === 'string' && declaredBy.trim(),
    'response_recovery_invalid', 'Recovery needs exact references and its actual declaring operator');
  const id = `research-response-recovery:${hashJson([project, callRef, sessionRef])}`;
  const previous = store.get<ResponseRecovery>(id);
  if (previous) {
    requireCondition(previous.kind === 'research-response-recovery' && previous.revision === 1 && previous.value.projectId === project
      && previous.value.state === 'applied' && canonical(previous.value.call) === canonical(callRef)
      && canonical(previous.value.sessionBefore) === canonical(sessionRef), 'response_recovery_invalid', 'The recovery identity was replaced');
    return previous;
  }
  const session = store.get<RecoverableContextSession>(sessionRef.id), call = store.get<ModelCall>(callRef.id);
  requireCondition(session && ['synthesis-session', 'assessment-session'].includes(session.kind) && object(session.value)
    && session.value.projectId === project && canonical(reference(session)) === canonical(sessionRef),
  'response_recovery_session_stale', 'Recovery requires the current exact supported session');
  const binding = responseSessionBinding(session);
  const draft = store.get<DiscoveryDraft>(binding.draft.id), question = store.get<Question>(binding.question.id);
  const inputs = uniqueRefs([binding.draft, binding.question, binding.environment, ...binding.inputs]);
  requireCondition(draft?.kind === 'discovery-draft' && question?.kind === 'question' && object(draft.value) && object(question.value) && draft.value.projectId === project
    && question.value.draftId === draft.id && ['open', 'unresolved'].includes(question.value.status)
    && canonical(draft.value.inputs) === canonical(binding.inputs) && session.value.result === null
    && inputs.every(ref => { const head = store.get(ref.id); return head && canonical(reference(head)) === canonical(ref); }),
  'response_recovery_binding_stale', 'The question, session result or research inputs changed');
  const effective = environments.effective(project), pilot = readerPilot(store, project);
  const dispatch = { ...(pilot ? pilotEnvironment(effective.environment.value, pilot.value) : effective.environment.value), workspace: effective.root };
  const synthesis = session.kind === 'synthesis-session', purpose = synthesis ? 'analyst' : 'assessor';
  requireCondition(!synthesis || pilot, 'response_recovery_profile_stale', 'Synthesis recovery requires its protected profile');
  const role = synthesis ? dispatch.implementer : dispatch.reviewer;
  requireCondition(call?.kind === 'model-call' && canonical(reference(call)) === canonical(callRef),
  'response_recovery_call_foreign', 'The succeeded call must belong to this exact consumer, profile and role');
  const paid = readResearchResponse(store, project, callRef, session, draft, question, role, pilot ? reference(pilot) : null);
  const { body, request: requestRef, response: responseRef, archive: archiveRef } = paid;
  requireCondition(!body.repositoryRoot || body.repositoryRoot === effective.root,
    'response_recovery_cursor_stale', 'The archived cursor, notes, materials context or workspace was already changed');
  if (isRef(body.graphBase)) {
    const graph = store.get(body.graphBase.id);
    requireCondition(graph && canonical(reference(graph)) === canonical(body.graphBase),
      'response_recovery_context_stale', 'The operation map changed after the paid request');
  }
  if (!synthesis) requireCondition(Array.isArray(body.observations) && body.observations.every((observation: any) =>
    observation.projectId === project && new Evidence(store).verify(observation)), 'response_recovery_evidence_stale', 'Assessment recovery requires its actual current evidence');
  const counter = store.get(`question-dispatch:${hashJson(question.id)}`);
  requireCondition(counter, 'response_recovery_binding_missing', 'Recovery requires the audited dispatch guard');
  const projectCounter = store.get(`project-dispatch:${hashJson(project)}`);
  const run = store.get<{ projectId: string; draftId: string; status: string; owner?: { pid: number; started: string } }>(`research-run:${hashJson([project, draft.id])}`);
  requireCondition(!run || run.kind === 'research-run' && run.value.projectId === project && run.value.draftId === draft.id,
    'response_recovery_binding_missing', 'The research owner record is foreign');
  if (run?.value.status === 'running') {
    const owner = run.value.owner;
    requireCondition(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.started === 'string' && owner.started.trim()
      && processStart(owner.pid) !== owner.started, 'response_recovery_consumer_running', 'The normal research consumer still owns this state');
  }
  requireCondition(!store.list<ModelCall>('model-call').some(record => record.value.projectId === project && record.value.status === 'running'),
    'response_recovery_call_running', 'Wait for active research calls before recovering a response');
  const scope: RecoveryScope = { id, project, draft: draft.id, question: question.id, purpose, role,
    profile: pilot ? reference(pilot) : null, session: sessionRef, archive: archiveRef, subject: paid.subject, payload: paid.payload,
    origin: { projectId: project, declaredBy, call: callRef, request: requestRef, response: responseRef, archive: archiveRef, sessionBefore: sessionRef },
    guards: uniqueRefs([sessionRef, callRef, requestRef, responseRef, archiveRef, reference(counter),
      ...(projectCounter ? [reference(projectCounter)] : []), ...(run ? [reference(run)] : []),
      ...inputs, ...effective.guards, ...(pilot ? [reference(pilot)] : [])]),
    delivered: false, applied: false };
  return current.run(scope, async () => {
    let failure: unknown = null;
    try {
      if (synthesis) await (await import('./synthesis-session.js')).synthesisSession(store, draft, question, effective.environment, dispatch, pilot!, body, paid.prompt);
      else await (await import('./assessment-session.js')).assessmentSession(store, draft, question, effective.environment, dispatch, pilot ?? undefined, body, paid.prompt);
    } catch (error) { failure = error; }
    const applied = store.get<ResponseRecovery>(id);
    if (applied) return applied;
    if (failure) throw failure;
    throw new EngineError('response_recovery_not_applied', 'The saved response did not produce a valid consumer state change');
  });
}
