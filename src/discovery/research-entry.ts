import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { processStart } from '../runtime/process-identity.js';
import type { Store, Revision } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { withChildInvocationAllowance } from './invocation-progress.js';
import { requireResearchEntry } from './projection-reader.js';
import { readResearchConsumerIntent, readResearchConsumerTurn, type ResearchConsumerIntent } from './response-recovery.js';
import type { ResearchAction, ResearchRun, ResearchTurn } from './research-model.js';
import { advanceInterpretationFlow, readInterpretationFlowReadyAt } from './interpretation-flow.js';

export { researchEntryState } from './projection-reader.js';

export const RESEARCH_ENTRY_READY = 'research_entry_ready';
export const RESEARCH_ENTRY_INTERPRETATION = 'research_entry_interpretation';
const entryFields = new Set(['frame', 'plan']);

/** Author input carries the exact accepted addresses needed by the next producer.
 * The request uses the common mandatory, pageable context delivery. */
export function researchEntryMaterial(store: Store, draft: Revision<DiscoveryDraft>) {
  const state = requireResearchEntry(store, draft), mandate = state.mandate!;
  const frame = state.questions.frame;
  return { context: { contract: 'discovery-entry/v1',
    brief: mandate.context.brief, objective: mandate.context.objective,
    frame: frame.value.status === 'answered' ? { question: reference(frame),
      answer: frame.value.answer, value: draft.value.fields.frame } : null }, guards: state.guards };
}

/** A paid initial answer is settled by the ordinary answer runner before the
 * plan-attempt reader sees the shared ordered turn history. */
function needsEntry(store: Store, draft: Revision<DiscoveryDraft>, runId: string): boolean {
  const plan = draft.value.questions.map(id => store.get<Question>(id)).find(q => q?.value.spec.field === 'plan');
  // An already produced but reopened/damaged plan is not an initial form.
  // The ordinary current-plan reader must refuse that history at its own door.
  if (!plan || plan.value.status !== 'answered') return draft.value.fields.plan === null;
  for (const row of store.list<ResearchTurn>('research-turn')) {
    if (row.value.run !== runId || row.value.status !== 'pending' || !isRef(row.value.question)) continue;
    const question = store.get<Question>(row.value.question.id, row.value.question.revision);
    if (question && entryFields.has(question.value.spec.field) && question.value.status === 'open'
      && question.value.answer === null && !Object.hasOwn(row.value, 'subject')) {
      readResearchConsumerTurn(store, reference(row)); return true;
    }
  }
  // Select only possible initial field operations before proving their origin.
  // Variant/deep intents belong to the existing attempt runner's refusal door.
  for (const intent of store.list<ResearchConsumerIntent>('research-consumer-intent')) {
    if (intent.value?.projectId !== draft.value.projectId || intent.value?.draft?.id !== draft.id
      || !['prepared', 'running'].includes(intent.value.state) || intent.value.cursor?.run !== runId
      || Object.hasOwn(intent.value.cursor, 'subject') || !isRef(intent.value.question)) continue;
    const question = store.get<Question>(intent.value.question.id, intent.value.question.revision);
    if (question && entryFields.has(question.value.spec.field)
      && question.value.status === 'open' && question.value.answer === null) {
      readResearchConsumerIntent(store, reference(intent)); return true;
    }
  }
  return false;
}

/** Both author/assessor calls and subsequent research share one allowance.
 * Payment, recovery, correction and acceptance remain in their common loops. */
export async function runResearchEntry(store: Store, project: string, draftId: string, limit: number,
  fields: (remaining: number) => Promise<Revision<ResearchRun>>,
  attempts: (remaining: number) => Promise<Revision<ResearchRun>>,
  options: { restoreOnly: boolean; signal?: AbortSignal }): Promise<Revision<ResearchRun>> {
  const runId = `research-run:${hashJson([project, draftId])}`;
  const draft = store.get<DiscoveryDraft>(draftId)!;
  // A ready plan already owns the established research-turn budget. The new
  // entry cap bounds the invocation that produces frame/plan and its handoff;
  // it must not reinterpret an existing plan's limit as a physical-call count.
  // An outer Driver allowance still applies to every physical call either way.
  if (!needsEntry(store, draft, runId)) return attempts(limit);
  const calls = () => store.list<ModelCall>('model-call')
    .filter(call => call.value.projectId === project && call.value.draftId === draftId).map(call => call.id);
  const before = new Set(calls());
  const remaining = () => Math.max(0, limit - calls().filter(id => !before.has(id)).length);
  return withChildInvocationAllowance(limit, async () => {
    let run = store.get<ResearchRun>(runId);
    requireCondition(!run || run.kind === 'research-run' && run.value.projectId === project && run.value.draftId === draftId,
      'research_entry_invalid', 'The initial research run belongs to another project or draft');
    if (run?.value.entryInterpretation) {
      const saved = run.value.entryInterpretation;
      requireCondition(isRef(saved.draft) && saved.draft.id === draftId && isRef(saved.frame)
        && (saved.ready === null || isRef(saved.ready?.basis) && isRef(saved.ready?.draft) && isRef(saved.ready?.frame)),
      'research_entry_invalid', 'The interpretation entry lost its exact original input or readiness address');
      if (saved.ready !== null) {
        const ready = await readInterpretationFlowReadyAt(store, project, saved.ready.basis);
        requireCondition(canonical({ draft: ready.draft, frame: ready.frame, basis: ready.basis }) === canonical(saved.ready)
          && canonical(ready.sourceFrame) === canonical(saved.frame),
        'research_entry_invalid', 'The interpretation entry names another readiness proof');
      } else {
        run = await advanceEntryInterpretation(store, run, remaining(), options);
        if (!run.value.entryInterpretation?.ready || options.restoreOnly || remaining() === 0) return run;
      }
    }
    for (;;) {
      run = await fields(Math.max(1, remaining()));
      if (run.value.pauseCode === RESEARCH_ENTRY_INTERPRETATION) {
        run = await advanceEntryInterpretation(store, run, remaining(), options);
        if (!run.value.entryInterpretation?.ready || options.restoreOnly || remaining() === 0) return run;
        continue;
      }
      if (run.value.pauseCode !== RESEARCH_ENTRY_READY) return run;
      if (!remaining()) return run;
      return attempts(remaining());
    }
  });
}

async function advanceEntryInterpretation(store: Store, run: Revision<ResearchRun>, allowance: number,
  options: { restoreOnly: boolean; signal?: AbortSignal }): Promise<Revision<ResearchRun>> {
  const input = run.value.entryInterpretation!;
  requireCondition(run.value.status !== 'running' || processStart(run.value.owner.pid) !== run.value.owner.started,
    'research_busy', 'This draft already has an active researcher');
  const owner = { pid: process.pid, started: processStart(process.pid) };
  requireCondition(owner.started, 'research_process_unknown', 'Cannot identify the research process');
  const save = (change: Partial<ResearchRun>, guards: Ref[] = []) => {
    run = store.writeMany<ResearchRun>([{ id: run.id, kind: run.kind, expected: run.revision,
      value: { ...run.value, ...change } }], [reference(run), ...guards])[0]!;
    return run;
  };
  save({ status: 'running', owner, ownerQuestion: null });
  try {
    // A changed mandate may still restore a paid D1 result, but cannot fund a
    // fresh interpretation or plan on an unaccepted owner input.
    const currentDraft = store.get<DiscoveryDraft>(run.value.draftId)!;
    let admission: EngineError | null = null;
    try { requireResearchEntry(store, currentDraft); }
    catch (error) { if (!(error instanceof EngineError)) throw error; admission = error; }
    const result = await advanceInterpretationFlow(store,
      { project: run.value.projectId, draft: input.draft, frame: input.frame },
      { allowance, ...options, restoreOnly: options.restoreOnly || admission !== null });
    if (admission) {
      const missing = currentDraft.value.questions.map(id => store.get<Question>(id)!)
        .find(q => ['brief', 'objective'].includes(q.value.spec.field) && q.value.status !== 'answered');
      return save({ status: missing ? 'needs_owner' : 'paused', pauseCode: admission.code, error: admission.message,
        ownerQuestion: missing ? { question: missing.id, reason: admission.message, searched: [] } : null,
        entryInterpretation: result.kind === 'ready'
          ? { draft: input.draft, frame: input.frame, ready: { draft: result.draft, frame: result.frame, basis: result.basis } }
          : { ...input, ready: null, continuation: result.continuation } });
    }
    if (result.kind === 'ready') return save({ status: 'paused', pauseCode: 'research_entry_continue', error: null,
      entryInterpretation: { draft: input.draft, frame: input.frame,
        ready: { draft: result.draft, frame: result.frame, basis: result.basis } } }, [result.basis]);
    const draft = store.get<DiscoveryDraft>(run.value.draftId)!;
    const frame = draft.value.questions.map(id => store.get<Question>(id)!).find(q => q.value.spec.field === 'frame')!;
    return save({ status: result.kind === 'owner_required' ? 'needs_owner' : 'paused',
      pauseCode: result.code, error: result.reason,
      ownerQuestion: result.kind === 'owner_required' ? { question: frame.id, reason: result.reason, searched: [] } : null,
      entryInterpretation: { ...input, ready: null, continuation: result.continuation } });
  } catch (error) {
    return save({ status: 'paused', pauseCode: error instanceof EngineError ? error.code : 'research_interrupted',
      error: error instanceof Error ? error.message : 'Interpretation entry was interrupted' });
  }
}

/** Stop a repeated rejected proposal before buying the same assessment again;
 * a changed draft or citations supplies a different basis and can proceed. */
export function requireEntryProgress(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  action: Extract<ResearchAction, { action: 'answer' }>, turns: Revision<ResearchTurn>[], pending: Ref): void {
  for (const turn of turns) {
    if (turn.id === pending.id || turn.value.status !== 'completed' || !turn.value.assessment
      || canonical(turn.value.question) !== canonical(reference(question))
      || canonical(turn.value.action) !== canonical(action)) continue;
    const intentRef = (turn.value as ResearchTurn & { consumerIntent?: Ref }).consumerIntent;
    if (!isRef(intentRef)) continue;
    const intent = readResearchConsumerIntent(store, intentRef);
    if (canonical(intent.value.draft) !== canonical(reference(draft))) continue;
    const assessment = store.get<{ verdict: string }>(turn.value.assessment.id, turn.value.assessment.revision);
    requireCondition(assessment?.value.verdict === 'supported', 'research_no_progress',
      'The same rejected entry proposal needs a correction or changed grounds before another assessment');
  }
}
