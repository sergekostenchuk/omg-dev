import type { Store, Revision, TransactionGuard } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { Environment } from '../runtime/environment.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { sourceIsCurrent, type Source } from '../evidence/evidence.js';
import { canonical, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { reference, isRef, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import { contextLookupKey, contextWorkspace, type ContextWorkspace } from './context-workspace.js';
import { readerPilot } from './reader-pilot.js';
import { readResearchContext } from './research-limits.js';
import { contextValue } from './working-context.js';
import { parseSynthesisSessionV2, parseSynthesisSessionV3, projectContextRecoveryTransition, CONTEXT_RECOVERY_SUPERSEDE_REASON,
  proveCheckpointRecord, researchCheckpointV2Holds, SYNTHESIS_SESSION_V3_PREFIX } from './research-consumer-transition.js';
import { readReaderResultAt } from './reader.js';
import { listResearchConsumerIntents, researchConsumerIntentId } from './response-recovery.js';
import { proveSynthesisSessionSubject, synthesisStepKey } from './synthesis-session.js';
import { callAddressesSubject, questionDispatchId, sameSubject, type V7PlanSubject } from './v7-managed-attempt.js';
import { planQuestionContract } from './continuation-packet.js';
import { EngineError } from '../errors.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';

export interface ContextSessionBinding { draft: Ref; question: Ref; environment: Ref; inputs: Ref[] }
export interface RecoverableContextSession {
  projectId: string; binding?: ContextSessionBinding; workspace?: ContextWorkspace; result: unknown;
  recoveries?: unknown[]; [key: string]: unknown;
}
export interface ContextRecoverySelector { record: Ref; pointer: string; page?: { offset: number; limit: number } }

/** Recovery adds an operator-selected original to the same session. Its paid
 * history, evidence cursors and budget identity are never replaced. */
export function recoverContextSession(store: Store, project: string, sessionRef: Ref, selector: ContextRecoverySelector): Revision<RecoverableContextSession> {
  requireCondition(isRef(sessionRef), 'context_recovery_invalid', 'Recovery requires an exact session reference');
  const session = store.get<RecoverableContextSession>(sessionRef.id);
  requireCondition(session && ['synthesis-session', 'assessment-session'].includes(session.kind)
    && session.value.projectId === project, 'context_session_foreign', 'Recovery requires this project\'s context session');
  if (session.kind === 'synthesis-session' && session.id.startsWith('synthesis-session:v2:'))
    return recoverContextSessionV2(store, project, session, sessionRef, selector);
  if (session.kind === 'synthesis-session' && session.id.startsWith(SYNTHESIS_SESSION_V3_PREFIX))
    return recoverContextSessionV3(store, project, session, sessionRef, selector);
  // №2000-11: a paid managed assessment session has no operator workspace
  // recovery; its only lawful path is the managed one through its exact origin.
  requireCondition(!(session.kind === 'assessment-session' && session.id.startsWith('assessment-session:v2:')),
    'context_recovery_invalid', 'A paid managed assessment session recovers only through its exact origin, never operator context recovery');
  requireCondition(canonical(reference(session)) === canonical(sessionRef), 'context_session_stale', 'Recover the current exact session revision');
  const binding = session.value.binding;
  requireCondition(binding && isRef(binding.draft) && isRef(binding.question) && isRef(binding.environment)
    && Array.isArray(binding.inputs) && binding.inputs.every(isRef),
  'context_binding_missing', 'Legacy or incomplete context sessions need an exact saved research binding');
  const draft = store.get<DiscoveryDraft>(binding.draft.id), question = store.get<Question>(binding.question.id);
  const environment = store.get<Environment>(binding.environment.id);
  requireCondition(draft?.kind === 'discovery-draft' && draft.value.projectId === project
    && question?.kind === 'question' && question.value.projectId === project && question.value.draftId === draft.id
    && Array.isArray(draft.value.questions) && draft.value.questions.includes(question.id) && question.value.stage === draft.value.stage
    && question.value.level === draft.value.level && question.value.consumer === draft.value.consumer
    && environment?.kind === 'environment' && environment.id === `environment:${project}` && environment.value.projectId === project,
  'context_binding_foreign', 'Session research must belong to the exact project, draft, question and environment');
  const bindingRefs = [binding.draft, binding.question, binding.environment, ...binding.inputs];
  requireCondition(Array.isArray(draft.value.inputs) && canonical(draft.value.inputs) === canonical(binding.inputs) && bindingRefs.every(ref => {
    const current = store.get(ref.id);
    return current && canonical(reference(current)) === canonical(ref);
  }), 'context_binding_stale', 'The saved session question, environment or research inputs changed');
  requireCondition(['open', 'unresolved'].includes(question.value.status) && session.value.result === null,
    'context_session_complete', 'An accepted answer or completed context session cannot be recovered');
  const workspace = contextWorkspace(session.value.workspace, session.value['focus']);
  requireCondition(typeof workspace.blocked === 'string' && workspace.blocked.length > 0,
    'context_session_not_blocked', 'Only a blocked context session needs explicit recovery');
  requireCondition(session.value.recoveries === undefined || Array.isArray(session.value.recoveries),
    'context_recovery_invalid', 'Saved recovery history must remain an array');
  const pilot = readerPilot(store, project);
  requireCondition(pilot, 'reader_pilot_required', 'Context recovery requires the current active reader preset');
  const dispatch = store.get<{ projectId: string; question: string; serial: number }>(`question-dispatch:${hashJson(binding.question.id)}`);
  requireCondition(dispatch?.kind === 'question-dispatch' && dispatch.value.projectId === project && dispatch.value.question === question.id
    && Number.isSafeInteger(dispatch.value.serial) && dispatch.value.serial > 0,
  'context_recovery_basis_missing', 'Recovery needs the question\'s saved dispatch counter');
  // Every audited dispatch advances this counter in its call transaction. The
  // captured revision closes insertion of a new call after the following scan.
  requireCondition(!store.list<ModelCall>('model-call').some(call =>
    call.value.projectId === project && call.value.questionId === question.id && call.value.status === 'running'),
  'context_call_active', 'Finish or recover the bound question\'s running model call before changing its context');
  requireCondition(selector && isRef(selector.record) && typeof selector.pointer === 'string',
    'context_recovery_invalid', 'Recovery requires an exact record and JSON pointer');
  const result = readResearchContext(store, draft, question.id, pilot, selector.record, selector.pointer, selector.page);
  requireCondition(!result.page || result.page.end > result.page.offset,
    'context_recovery_empty', 'An empty page cannot establish new context material');
  const key = contextLookupKey(result);
  requireCondition(!workspace.entries.some(entry => entry.key === key),
    'context_recovery_unchanged', 'Select genuinely different material or a different page to recover this session');
  const record = store.get<Record<string, unknown>>(selector.record.id, selector.record.revision)!;
  const sourceRefs: Ref[] = [];
  const source = (ref: unknown) => {
    if (!isRef(ref) || !ref.id.startsWith('source:')) return;
    const saved = store.get<Source>(ref.id);
    requireCondition(saved?.kind === 'source' && saved.value.projectId === project
      && canonical(reference(saved)) === canonical(ref) && sourceIsCurrent(saved.value),
    'context_source_stale', 'New recovery material must retain its current source');
    sourceRefs.push(ref);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    source(item['source']); source(item['ref']);
    for (const child of Object.values(item)) visit(child);
  };
  visit(result.value);
  if (record.kind === 'research-checkpoint') visit(record.value['observations']);
  const parts = selector.pointer.split('/');
  for (let end = 1; end < parts.length; end++) {
    const parent = contextValue(record.value, parts.slice(0, end).join('/'));
    if (parent && typeof parent === 'object') { source((parent as Record<string, unknown>)['source']); source((parent as Record<string, unknown>)['ref']); }
  }
  const previousFinalization = session.value['finalization'] as {lookups:number} | undefined;
  requireCondition(previousFinalization === undefined || previousFinalization && Number.isSafeInteger(previousFinalization.lookups) && previousFinalization.lookups >= 0,
    'context_recovery_invalid','Recovery cannot replace malformed final-stage lookup accounting');
  const finalization = session.kind === 'synthesis-session'
    ? {lookups:Math.max(previousFinalization?.lookups??0,workspace.sinceProgress)} : undefined;
  const { blocked, ...unblocked } = workspace;
  return store.writeMany<RecoverableContextSession>([{ id: session.id, kind: session.kind, expected: session.revision,
    value: { ...session.value, ...(finalization ? {finalization} : {}), workspace: { ...unblocked, entries: [...workspace.entries, { key, result }], sinceProgress: 0 },
      recoveries: [...(session.value.recoveries ?? []), { origin: 'operator', session: sessionRef, reason: blocked, selector, key }] } }],
  uniqueRefs([sessionRef, ...bindingRefs, selector.record, reference(pilot), reference(dispatch), ...sourceRefs]))[0]!;
}

/** The v2 operator context recovery (№1555 X15/X31/X52): the shared v2
 * binding parse; no subject-matter workspace change while a claim is
 * unresolved (including a saved response before its application); the write
 * carries the session CAS plus absence-of-new-claim guards for the current
 * head's step. The transition value comes from the one shared formula. */
function recoverContextSessionV2(store: Store, project: string, session: Revision<RecoverableContextSession>,
  sessionRef: Ref, selector: ContextRecoverySelector): Revision<RecoverableContextSession> {
  const parsed = parseSynthesisSessionV2(session.value);
  requireCondition(parsed, 'context_binding_missing', 'The v2 session must retain its producer contract and binding');
  const binding = parsed.binding;
  const draft = store.get<DiscoveryDraft>(binding.draft.id, binding.draft.revision);
  const questionHead = store.get<Question>(binding.question.id);
  requireCondition(draft?.kind === 'discovery-draft' && questionHead?.kind === 'question'
    && draft.value.projectId === project && questionHead.value.projectId === project
    && questionHead.value.draftId === draft.id && draft.value.questions.includes(questionHead.id),
  'context_binding_foreign', 'Session research must belong to the exact project, draft, question and environment');
  requireCondition(['open', 'unresolved'].includes(questionHead.value.status) && session.value.result === null,
    'context_session_complete', 'An accepted answer or completed context session cannot be recovered');
  requireCondition(canonical(reference(session)) === canonical(sessionRef),
    'context_session_stale', 'Recover the current exact session revision');
  const intents = listResearchConsumerIntents(store, project, draft.id)
    .filter(intent => ['synthesis', 'consolidation'].includes(intent.value.kind)
      && intent.value.owner.id === session.id && ['prepared', 'running'].includes(intent.value.state));
  requireCondition(!intents.some(intent => intent.value.state === 'running'),
    'context_recovery_claim_pending',
    'A claimed step without its application cannot accept an operator context replacement');
  const pilot = readerPilot(store, project);
  requireCondition(pilot, 'reader_pilot_required', 'Context recovery requires the current active reader preset');
  const dispatchId = `question-dispatch:${hashJson(binding.question.id)}`;
  const dispatch = store.get<{ projectId: string; question: string; serial: number }>(dispatchId);
  // The dispatch counter is the audit anchor when a call exists; before any
  // paid call its proven absence is itself a guardable dependency (№1555 X31
  // prepared-supersede case; урок 43).
  requireCondition(!dispatch || dispatch.kind === 'question-dispatch' && dispatch.value.projectId === project
    && dispatch.value.question === questionHead.id && Number.isSafeInteger(dispatch.value.serial) && dispatch.value.serial > 0,
  'context_recovery_basis_missing', 'Recovery needs the question\'s saved dispatch counter');
  const dispatchGuard: TransactionGuard = dispatch ? reference(dispatch) : { id: dispatchId, absent: true };
  requireCondition(!store.list<ModelCall>('model-call').some(call =>
    call.value.projectId === project && call.value.questionId === questionHead.id && call.value.status === 'running'),
  'context_call_active', 'Finish or recover the bound question\'s running model call before changing its context');
  requireCondition(selector && isRef(selector.record) && typeof selector.pointer === 'string',
    'context_recovery_invalid', 'Recovery requires an exact record and JSON pointer');
  // Origin proof precedes any subject write (№1658 К1/поправка 8): the record
  // the recovery names must stand on its own producer chain — a reader-result
  // by its general reader, a checkpoint by re-derivation from exact sources.
  const proofRecord = store.get<Record<string, any>>(selector.record.id, selector.record.revision);
  requireCondition(proofRecord && proofRecord.value !== null && typeof proofRecord.value === 'object'
    && !Array.isArray(proofRecord.value)
    && hashJson(proofRecord.value) === proofRecord.hash
    && canonical(reference(proofRecord)) === canonical(selector.record),
  'context_lookup_integrity', 'The exact recovery record is missing or changed');
  if (proofRecord.kind === 'reader-result') readReaderResultAt(store, project, selector.record);
  else if (proofRecord.kind === 'research-checkpoint') proveCheckpointRecord(store, proofRecord);
  const result = readResearchContext(store, draft, questionHead.id, pilot, selector.record, selector.pointer, selector.page);
  return writeSessionRecovery(store, project, session, sessionRef, selector, result, intents,
    [reference(questionHead), reference(pilot), dispatchGuard]);
}

/** The one write of an operator recovery of a v2 or v3 session: the shared
 * transition formula the chain reader re-derives, the sources the new
 * material names, the session CAS and absence-of-new-claim guards for both
 * step variants of the current head, plus the caller's scope guards. */
function writeSessionRecovery(store: Store, project: string, session: Revision<RecoverableContextSession>, sessionRef: Ref,
  selector: ContextRecoverySelector, result: ReturnType<typeof readResearchContext>,
  intents: ReturnType<typeof listResearchConsumerIntents>, scopeGuards: TransactionGuard[]): Revision<RecoverableContextSession> {
  const workspace = contextWorkspace(session.value.workspace, session.value['focus']);
  const preparedAtHead = intents.filter(intent => intent.value.state === 'prepared'
    && intent.value.owner.revision === session.revision);
  // The operator transition needs a proven ground: an applied blocked outcome
  // of this session, or a merely-prepared step it lawfully supersedes (X31).
  const reason = typeof workspace.blocked === 'string' && workspace.blocked.length > 0
    ? workspace.blocked
    : (requireCondition(preparedAtHead.length > 0, 'context_session_not_blocked',
      'Only a blocked context session or a supersede of a merely-prepared step needs explicit recovery'),
      CONTEXT_RECOVERY_SUPERSEDE_REASON);
  const transition = projectContextRecoveryTransition({ before: session.value as never,
    beforeRef: sessionRef, selector, result, reason });
  const record = store.get<Record<string, unknown>>(selector.record.id, selector.record.revision)!;
  const sourceRefs: Ref[] = [];
  const source = (ref: unknown) => {
    if (!isRef(ref) || !ref.id.startsWith('source:')) return;
    const saved = store.get<Source>(ref.id);
    requireCondition(saved?.kind === 'source' && saved.value.projectId === project
      && canonical(reference(saved)) === canonical(ref) && sourceIsCurrent(saved.value),
    'context_source_stale', 'New recovery material must retain its current source');
    sourceRefs.push(ref);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    source(item['source']); source(item['ref']);
    for (const child of Object.values(item)) visit(child);
  };
  visit(result.value);
  if (record.kind === 'research-checkpoint') visit(record.value['observations']);
  const parts = selector.pointer.split('/');
  for (let end = 1; end < parts.length; end++) {
    const parent = contextValue(record.value, parts.slice(0, end).join('/'));
    if (parent && typeof parent === 'object') { source((parent as Record<string, unknown>)['source']); source((parent as Record<string, unknown>)['ref']); }
  }
  // Absence-of-new-claim guards cover both step variants of the current head;
  // a prepared step of this head is pinned so it cannot claim mid-write.
  const claimGuards: TransactionGuard[] = (['synthesis', 'consolidation'] as const).map(kind => {
    const intentId = researchConsumerIntentId(project, kind, synthesisStepKey(session as never), 0);
    const existing = store.get(intentId);
    return existing ? reference(existing) : { id: intentId, absent: true as const };
  });
  return store.writeMany<RecoverableContextSession>([{ id: session.id, kind: session.kind,
    expected: session.revision, value: transition.session as unknown as RecoverableContextSession }],
  uniqueTransactionGuards([sessionRef, selector.record, ...scopeGuards, ...sourceRefs, ...claimGuards]))[0]!;
}

/** DR3a3-S4 (решения 5, 6): the record an operator recovery of a v3 session
 * may name. A reader-result is the common reader's exact result (shared by
 * subjects of one Question); a checkpoint is only a v2 note of the session's
 * own subject — never a v1 note of the physical Question or another subject's
 * note, so the operator cannot make a foreign note this session's own. One
 * predicate for the writer below and the v3 chain reader. */
export function recoveryRecordSubjectHolds(record: Revision<Record<string, any>>, subject: V7PlanSubject): boolean {
  if (record.kind !== 'research-checkpoint') return true;
  return researchCheckpointV2Holds(record.value) && sameSubject(record.value.subject, subject);
}

/** The v3 operator context recovery: the v2 rules on the session's exact
 * subject. The answered plan anchor is the v7 norm, so the session's subject
 * must be proven and still current instead. Decision 5: the subject step's
 * dispatch counter and the common reader's physical Question counter are both
 * guarded, and a running call of either scope refuses — a dispatch between
 * this check and the write conflicts. */
function recoverContextSessionV3(store: Store, project: string, session: Revision<RecoverableContextSession>,
  sessionRef: Ref, selector: ContextRecoverySelector): Revision<RecoverableContextSession> {
  const parsed = parseSynthesisSessionV3(session.value);
  requireCondition(parsed, 'context_binding_missing', 'The v3 session must retain its producer contract, binding and subject');
  const binding = parsed.binding, subject = binding.subject;
  const draft = store.get<DiscoveryDraft>(binding.draft.id, binding.draft.revision);
  const draftHead = store.get<DiscoveryDraft>(binding.draft.id);
  const questionHead = store.get<Question>(binding.question.id);
  requireCondition(draft?.kind === 'discovery-draft' && draftHead?.kind === 'discovery-draft' && questionHead?.kind === 'question'
    && draft.value.projectId === project && questionHead.value.projectId === project
    && questionHead.value.draftId === draft.id && draft.value.questions.includes(questionHead.id),
  'context_binding_foreign', 'Session research must belong to the exact project, draft, question and environment');
  requireCondition(session.value.result === null, 'context_session_complete',
    'An accepted answer or completed context session cannot be recovered');
  requireCondition(canonical(reference(session)) === canonical(sessionRef),
    'context_session_stale', 'Recover the current exact session revision');
  try {
    proveSynthesisSessionSubject(store, session);
    planQuestionContract(store, draftHead, questionHead, subject);
  } catch (error) {
    if (error instanceof EngineError)
      throw new EngineError('context_binding_stale', `The session plan subject is no longer current: ${error.message}`);
    throw error;
  }
  const intents = listResearchConsumerIntents(store, project, draft.id)
    .filter(intent => ['synthesis', 'consolidation'].includes(intent.value.kind)
      && intent.value.owner.id === session.id && ['prepared', 'running'].includes(intent.value.state));
  requireCondition(!intents.some(intent => intent.value.state === 'running'),
    'context_recovery_claim_pending',
    'A claimed step without its application cannot accept an operator context replacement');
  const pilot = readerPilot(store, project);
  requireCondition(pilot, 'reader_pilot_required', 'Context recovery requires the current active reader preset');
  const counterGuards: TransactionGuard[] = [subject, null].map(scope => {
    const id = questionDispatchId(project, questionHead.id, scope);
    const counter = store.get<{ projectId: string; question: string; serial: number; subject?: unknown }>(id);
    requireCondition(!counter || counter.kind === 'question-dispatch' && counter.value.projectId === project
      && counter.value.question === questionHead.id && Number.isSafeInteger(counter.value.serial) && counter.value.serial > 0
      && (scope ? sameSubject((counter.value.subject ?? null) as V7PlanSubject | null, scope) : !Object.hasOwn(counter.value, 'subject')),
    'context_recovery_basis_missing', 'Recovery needs the saved dispatch counters of its subject and Question');
    return counter ? reference(counter) : { id, absent: true as const };
  });
  requireCondition(!store.list<ModelCall>('model-call').some(call => call.value.projectId === project && call.value.status === 'running'
    && (call.value.questionId === questionHead.id
      || callAddressesSubject(call.value as unknown as Record<string, unknown>, reference(questionHead), subject))),
  'context_call_active', 'Finish or recover the running model call of this subject or Question before changing its context');
  requireCondition(selector && isRef(selector.record) && typeof selector.pointer === 'string',
    'context_recovery_invalid', 'Recovery requires an exact record and JSON pointer');
  const proofRecord = store.get<Record<string, any>>(selector.record.id, selector.record.revision);
  requireCondition(proofRecord && proofRecord.value !== null && typeof proofRecord.value === 'object'
    && !Array.isArray(proofRecord.value)
    && hashJson(proofRecord.value) === proofRecord.hash
    && canonical(reference(proofRecord)) === canonical(selector.record),
  'context_lookup_integrity', 'The exact recovery record is missing or changed');
  requireCondition(recoveryRecordSubjectHolds(proofRecord, subject), 'context_reference_foreign',
    'A v3 session recovers only its own subject\'s notes; another subject\'s or a field-path note is foreign');
  if (proofRecord.kind === 'reader-result') readReaderResultAt(store, project, selector.record);
  else if (proofRecord.kind === 'research-checkpoint') proveCheckpointRecord(store, proofRecord);
  const result = readResearchContext(store, draft, questionHead.id, pilot, selector.record, selector.pointer, selector.page);
  return writeSessionRecovery(store, project, session, sessionRef, selector, result, intents,
    [reference(questionHead), reference(draftHead), subject.planAnswer, reference(pilot), ...counterGuards]);
}
