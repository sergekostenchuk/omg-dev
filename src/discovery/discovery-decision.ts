import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import type { Store, Revision, TransactionGuard } from '../storage/store.js';
import { captureView } from '../storage/store-view.js';
import { Discovery, type DiscoveryDraft, type Question } from './discovery.js';
import { discoveryContext, discoveryOutcome, discoveryDecisionId, discoveryChoiceRoundId, isDiscoveryV5,
  readDiscoveryConditionDecision, type DiscoveryConditionDecision, type DiscoveryConditionDecisionV2,
  type DiscoveryChoiceRound, type DiscoveryChoiceOption } from './discovery-outcome.js';
import { DISCOVERY_CHOICE_ACTION, DiscoveryChoiceAuthority, requireDiscoveryChoiceAuthority,
  type DiscoveryChoiceScope } from '../product/owner-authority.js';

export interface DiscoveryConditionRequest extends DiscoveryChoiceScope {}
export interface DiscoveryConditionOutcome {
  decision: Revision<DiscoveryConditionDecision>; repeated: boolean;
  nextAction: 'owner-discovery-choice' | 'research-stage';
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const placeholderRef: Ref = { id: 'discovery-choice', revision: 1, hash: '0'.repeat(64) };

function authorityFailure(result: ReturnType<typeof requireDiscoveryChoiceAuthority>): never {
  if (result.ok) throw new EngineError('owner_authority_internal', 'Authority refusal unexpectedly delivered a value');
  throw new EngineError(result.refusal.code, result.refusal.message,
    { ...result.refusal.at, door: 'owner-discovery-choice' });
}

function requireRequest(request: unknown): DiscoveryConditionRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new EngineError('discovery_choice_invalid', 'A Discovery choice needs an exact scoped request',
      { door: 'owner-discovery-choice' });
  const value = request as Record<string, unknown>;
  if (typeof value.project !== 'string' || value.project.length === 0
    || typeof value.draft !== 'string' || value.draft.length === 0 || !isRef(value.verdictRef)
    || !isRef(value.reportRef) || typeof value.conditionId !== 'string' || value.conditionId.length === 0
    || typeof value.optionId !== 'string' || value.optionId.length === 0
    || Object.keys(value).some(key => !['project', 'draft', 'verdictRef', 'reportRef', 'conditionId', 'optionId'].includes(key)))
    throw new EngineError('discovery_choice_invalid',
      'A choice needs project, draft, exact verdict/report, condition and option only',
      { draft: typeof value.draft === 'string' ? value.draft : 'discovery-choice', door: 'owner-discovery-choice' });
  return { project: value.project, draft: value.draft, verdictRef: value.verdictRef,
    reportRef: value.reportRef, conditionId: value.conditionId, optionId: value.optionId };
}

type ChoiceVerdict = Revision<{value: {outcome: string; researchReport: Ref; conditions: {
  id: string; kind: string; options?: DiscoveryChoiceOption[];
}[]}}>;
interface PreparedChoice {
  decision: DiscoveryConditionRequest; draft: Revision<DiscoveryDraft>; question: Revision<Question>;
  id: string; roundId: string; existing: Revision<DiscoveryConditionDecision> | null;
  reopened: boolean;
  related: ReturnType<typeof discoveryContext>;
  conditions: {id: string; kind: string; options?: DiscoveryChoiceOption[]}[];
}

function prepareChoice(store: Store, decision: DiscoveryConditionRequest): PreparedChoice {
  const draft = store.get<DiscoveryDraft>(decision.draft);
  const question = draft?.kind === 'discovery-draft'
    ? draft.value.questions.map(id => store.get<Question>(id)).find(q => q?.value.spec.field === 'verdict') : null;
  const current = { project: draft?.value.projectId ?? decision.project, draft: decision.draft,
    question: question ? reference(question) : null, verdictRef: question?.value.answer ?? null,
    reportRef: decision.reportRef, conditionId: decision.conditionId, door: 'owner-discovery-choice' };
  const refuse = (code: string, message: string): never => {
    throw new EngineError(code, `[${decision.draft}] ${message}`, current);
  };
  if (!draft || draft.kind !== 'discovery-draft' || draft.value.projectId !== decision.project
    || !isDiscoveryV5(draft.value) || !question)
    return refuse('discovery_choice_foreign', 'The choice needs this project’s Discovery v6 verdict');
  const id = discoveryDecisionId(decision.project, draft.id, decision.verdictRef, decision.conditionId);
  const roundId = discoveryChoiceRoundId(decision.project, draft.id, decision.verdictRef);
  const existing = store.get<DiscoveryConditionDecision>(id), round = store.get<DiscoveryChoiceRound>(roundId);
  const reopened = Boolean(question.value.status === 'open' && round && same(reference(question), round.value.reopened));
  if (!(question.value.status === 'answered' && same(question.value.answer, decision.verdictRef)) && !reopened)
    return refuse('discovery_choice_stale', 'Reload the current verdict and its choices');
  let related: ReturnType<typeof discoveryContext>;
  try { related = discoveryContext(store, draft, question); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return refuse('discovery_choice_stale', 'The research grounds changed; reload the current choice');
  }
  const verdict = store.get<ChoiceVerdict['value']>(decision.verdictRef.id, decision.verdictRef.revision);
  if (!verdict || !same(reference(verdict), decision.verdictRef) || verdict.value.value.outcome !== 'conditional'
    || !same(verdict.value.value.researchReport, decision.reportRef)
    || !same(decision.reportRef, related.context!.fields.researchReport?.answer ?? null))
    return refuse('discovery_choice_stale', 'The conditional verdict and exact report must remain current');
  const conditions = verdict.value.value.conditions.filter(condition => condition.kind === 'owner_choice');
  const condition = conditions.find(item => item.id === decision.conditionId);
  if (!condition?.options?.some(option => option.optionId === decision.optionId))
    return refuse('discovery_choice_invalid',
      'Select an offered option of this exact owner condition; evidence is not an owner choice');
  return { decision, draft, question, id, roundId, existing, reopened, related, conditions };
}

/** Trusted CLI preflight: prove the exact offered subject before minting the one-use scoped invitation. */
export function validateDiscoveryConditionRequest(store: Store, request: unknown): DiscoveryConditionRequest {
  return prepareChoice(store, requireRequest(request)).decision;
}

/** The single protected producer. Ordinary ProductEngine/HTTP callers carry only an actor string and are refused. */
export function answerDiscoveryCondition(store: Store, request: unknown, authority: unknown): DiscoveryConditionOutcome {
  if (!(authority instanceof DiscoveryChoiceAuthority)) {
    const refused = requireDiscoveryChoiceAuthority(authority, { store, action: DISCOVERY_CHOICE_ACTION,
      scope: { project: '', draft: '', verdictRef: placeholderRef, reportRef: placeholderRef,
        conditionId: '', optionId: '' } });
    return authorityFailure(refused);
  }
  const scope = requireRequest(request);
  const admitted = requireDiscoveryChoiceAuthority(authority, { store, action: DISCOVERY_CHOICE_ACTION, scope });
  if (!admitted.ok) return authorityFailure(admitted);
  const prepared = prepareChoice(store, scope), { decision, draft, question, id, roundId,
    reopened, related, conditions } = prepared;
  const current = { project: decision.project, draft: decision.draft, question: reference(question),
    verdictRef: question.value.answer ?? null, reportRef: decision.reportRef,
    conditionId: decision.conditionId, door: 'owner-discovery-choice' };
  const refuse = (code: string, message: string): never => {
    throw new EngineError(code, `[${decision.draft}] ${message}`, current);
  };
  const repeat = (choice: PreparedChoice): DiscoveryConditionOutcome | null => {
    if (!choice.existing) return null;
    const proved = readDiscoveryConditionDecision(store, { project: decision.project, draft: draft.id,
      verdictRef: decision.verdictRef, reportRef: decision.reportRef,
      conditionId: decision.conditionId, record: reference(choice.existing) });
    if (proved.record.value.optionId !== decision.optionId)
      return refuse('discovery_choice_conflict', 'This condition already has another owner decision');
    return { decision: proved.record, repeated: true,
      nextAction: choice.reopened ? 'research-stage' : 'owner-discovery-choice' };
  };
  const repeated = repeat(prepared);
  if (repeated) return repeated;
  if (reopened) return refuse('discovery_choice_stale', 'The completed choice round is already being reconsidered');
  const outcome = discoveryOutcome(store, draft);
  const guards: TransactionGuard[] = [...outcome.guards, ...related.guards, reference(question), reference(draft)];
  const capture = captureView(store);
  const applied = requireDiscoveryChoiceAuthority(authority, { store, action: DISCOVERY_CHOICE_ACTION, scope });
  if (!applied.ok) return authorityFailure(applied);
  const value: DiscoveryConditionDecisionV2 = { contract: 'discovery-condition-decision/v2',
    database: store.databaseId, projectId: decision.project, draftId: draft.id,
    verdictRef: decision.verdictRef, reportRef: decision.reportRef, conditionId: decision.conditionId,
    optionId: decision.optionId, actor: 'local-owner', session: applied.value.session };
  const saved = capture.view.write<DiscoveryConditionDecision>({
    id, kind: 'discovery-condition-decision', expected: 0, value
  });
  const decisions = conditions.map(item => {
    const address = discoveryDecisionId(decision.project, draft.id, decision.verdictRef, item.id);
    if (address === id) return reference(saved);
    const prior = store.get<DiscoveryConditionDecision>(address);
    guards.push(prior ? reference(prior) : { id: address, absent: true });
    if (!prior) return null;
    return reference(readDiscoveryConditionDecision(store, { project: decision.project, draft: draft.id,
      verdictRef: decision.verdictRef, reportRef: decision.reportRef,
      conditionId: item.id, record: reference(prior) }).record);
  });
  let completed = false;
  if (decisions.every((ref): ref is Ref => ref !== null)) {
    const opened = new Discovery(capture.view).reopen(question.id, question.revision);
    const complete: DiscoveryChoiceRound = { contract: 'discovery-choice-round/v1',
      projectId: decision.project, draftId: draft.id, verdictRef: decision.verdictRef,
      reportRef: decision.reportRef, question: reference(question), reopened: reference(opened), decisions };
    capture.view.write({ id: roundId, kind: 'discovery-choice-round', expected: 0, value: complete });
    completed = true;
  }
  try {
    const written = store.writeMany<DiscoveryConditionDecision>(capture.writes,
      uniqueTransactionGuards([...guards, ...capture.guards, applied.value.session]));
    return { decision: written[0]!, repeated: false,
      nextAction: completed ? 'research-stage' : 'owner-discovery-choice' };
  } catch (error) {
    if (error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code)) {
      if (store.get<DiscoveryConditionDecision>(id)) {
        const recoveredAdmission = requireDiscoveryChoiceAuthority(authority,
          { store, action: DISCOVERY_CHOICE_ACTION, scope });
        if (!recoveredAdmission.ok) return authorityFailure(recoveredAdmission);
        const recovered = repeat(prepareChoice(store, scope));
        if (recovered) return recovered;
      }
    }
    throw error;
  }
}
