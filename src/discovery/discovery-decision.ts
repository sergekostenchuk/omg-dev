import { canonical } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import type { Store, Revision, TransactionGuard } from '../storage/store.js';
import { captureView } from '../storage/store-view.js';
import { Discovery, type DiscoveryDraft, type Question } from './discovery.js';
import { discoveryContext, discoveryOutcome, discoveryDecisionId, discoveryChoiceRoundId, isDiscoveryV5,
  type DiscoveryConditionDecision, type DiscoveryChoiceRound, type DiscoveryChoiceOption } from './discovery-outcome.js';

export interface DiscoveryConditionRequest {
  project: string; draft: string; verdictRef: Ref; conditionId: string; optionId: string;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The command is the owner's input. A research action can propose options, never execute this door. */
export function answerDiscoveryCondition(store: Store, request: DiscoveryConditionRequest, actor: string): Revision<DiscoveryConditionDecision> {
  requireCondition(request && typeof request.project === 'string' && request.project.length > 0
    && typeof request.draft === 'string' && request.draft.length > 0 && isRef(request.verdictRef)
    && typeof request.conditionId === 'string' && request.conditionId.length > 0
    && typeof request.optionId === 'string' && request.optionId.length > 0,
  'discovery_choice_invalid', `[${request?.draft ?? 'discovery-choice'}] A choice needs project, draft, exact verdict, condition and option addresses`);
  const draft = store.get<DiscoveryDraft>(request.draft);
  const question = draft?.kind === 'discovery-draft'
    ? draft.value.questions.map(id => store.get<Question>(id)).find(q => q?.value.spec.field === 'verdict') : null;
  const current = { project: draft?.value.projectId ?? request.project, draft: request.draft,
    question: question ? reference(question) : null, verdictRef: question?.value.answer ?? null, conditionId: request.conditionId };
  const refuse = (code: string, message: string): never => { throw new EngineError(code, `[${request.draft}] ${message}`, current); };
  if (!draft || draft.kind !== 'discovery-draft' || draft.value.projectId !== request.project || !isDiscoveryV5(draft.value) || !question)
    return refuse('discovery_choice_foreign', 'The choice needs this project’s Discovery v5 verdict');
  if (typeof actor !== 'string' || !actor.trim()) return refuse('actor_missing', 'Decision needs an owner identity');
  const id = discoveryDecisionId(request.project, draft.id, request.verdictRef, request.conditionId);
  const roundId = discoveryChoiceRoundId(request.project, draft.id, request.verdictRef);
  const existing = store.get<DiscoveryConditionDecision>(id), round = store.get<DiscoveryChoiceRound>(roundId);
  const reopened = question.value.status === 'open' && round && same(reference(question), round.value.reopened);
  if (!(question.value.status === 'answered' && same(question.value.answer, request.verdictRef)) && !reopened)
    return refuse('discovery_choice_stale', 'Reload the current verdict and its choices');
  // A completed round may be repeated during its reopen, but cannot migrate to a revised report.
  let related: ReturnType<typeof discoveryContext>;
  try { related = discoveryContext(store, draft, question); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return refuse('discovery_choice_stale', 'The research grounds changed; reload the current choice');
  }
  const verdict = store.get<{value: {outcome: string; researchReport: Ref; conditions: {
    id: string; kind: string; options?: DiscoveryChoiceOption[];
  }[]}}>(request.verdictRef.id, request.verdictRef.revision);
  if (!verdict || !same(reference(verdict), request.verdictRef) || verdict.value.value.outcome !== 'conditional'
    || !same(verdict.value.value.researchReport, related.context!.fields.researchReport?.answer ?? null))
    return refuse('discovery_choice_stale', 'The conditional verdict and its report must remain current');
  const conditions = verdict.value.value.conditions.filter(c => c.kind === 'owner_choice');
  const condition = conditions.find(c => c.id === request.conditionId);
  if (!condition?.options?.some(option => option.optionId === request.optionId))
    return refuse('discovery_choice_invalid', 'Select an offered option of this exact owner condition; evidence is not an owner choice');
  if (existing) {
    if (existing.value.optionId !== request.optionId || existing.value.actor !== actor)
      return refuse('discovery_choice_conflict', 'This condition already has its owner decision');
    return existing;
  }
  if (reopened) return refuse('discovery_choice_stale', 'The completed choice round is already being reconsidered');
  const outcome = discoveryOutcome(store, draft);
  const value: DiscoveryConditionDecision = { contract: 'discovery-condition-decision/v1', projectId: request.project,
    draftId: draft.id, verdictRef: request.verdictRef, conditionId: request.conditionId, optionId: request.optionId, actor };
  const guards: TransactionGuard[] = [...outcome.guards, ...related.guards, reference(question), reference(draft)];
  const capture = captureView(store);
  const saved = capture.view.write<DiscoveryConditionDecision>({ id, kind: 'discovery-condition-decision', expected: 0, value });
  const decisions = conditions.map(c => {
    const address = discoveryDecisionId(request.project, draft.id, request.verdictRef, c.id);
    if (address === id) return reference(saved);
    const prior = store.get<DiscoveryConditionDecision>(address);
    guards.push(prior ? reference(prior) : { id: address, absent: true });
    return prior ? reference(prior) : null;
  });
  if (decisions.every((ref): ref is Ref => ref !== null)) {
    const opened = new Discovery(capture.view).reopen(question.id, question.revision);
    const complete: DiscoveryChoiceRound = { contract: 'discovery-choice-round/v1', projectId: request.project,
      draftId: draft.id, verdictRef: request.verdictRef, reportRef: verdict.value.value.researchReport,
      question: reference(question), reopened: reference(opened), decisions };
    capture.view.write({ id: roundId, kind: 'discovery-choice-round', expected: 0, value: complete });
  }
  return store.writeMany<DiscoveryConditionDecision>(capture.writes,
    uniqueTransactionGuards([...guards, ...capture.guards]))[0]!;
}
