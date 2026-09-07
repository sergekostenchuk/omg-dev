import type { Store, Revision } from '../storage/store.js';
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
  const { blocked, ...unblocked } = workspace;
  return store.writeMany<RecoverableContextSession>([{ id: session.id, kind: session.kind, expected: session.revision,
    value: { ...session.value, workspace: { ...unblocked, entries: [...workspace.entries, { key, result }], sinceProgress: 0 },
      recoveries: [...(session.value.recoveries ?? []), { origin: 'operator', session: sessionRef, reason: blocked, selector, key }] } }],
  uniqueRefs([sessionRef, ...bindingRefs, selector.record, reference(pilot), reference(dispatch), ...sourceRefs]))[0]!;
}
