import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { Store, type Revision, type TransactionGuard } from '../storage/store.js';
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

// Variant owner acts have a separate authority and an immutable decision/state pair. Conditional choices above
// retain their own contract. These readers use saved exact grounds; only the new-act door exercises a live bearer.
import { hashJson } from '../canonical.js';
import { requireVariantChoiceAuthority, readVariantChoiceSession,
  readVariantChoiceSessionGrant, type VariantChoiceSession, type VariantChoiceSessionGrant } from '../product/owner-authority.js';
import { readProjectMode } from '../product/project-mode.js';
import { readVariantGeneration, readVariantModelDecision } from './variant-session.js';
import { VARIANT_OWNER_ACTION, VARIANT_OWNER_DECISION_CONTRACT, VARIANT_STATE_CONTRACT,
  decodeVariantChoiceScope, decodeVariantOwnerDecision, decodeVariantState, variantRecordId, variantStateId,
  type VariantChoiceScope, type VariantOwnerDecision, type VariantState } from './variant-decision.js';
import type { OmResult } from '../om/refusal.js';

export interface ProvenVariantOwnerDecision {
  verification: 'proven'; decision: Revision<VariantOwnerDecision>; state: Revision<VariantState>;
  session: Revision<VariantChoiceSession>; grant: Revision<VariantChoiceSessionGrant>;
}
export interface VariantOwnerOutcome { decision: Revision<VariantOwnerDecision>; state: Revision<VariantState>; repeated: boolean }
const ownerVariantInvalid = (message: string, code = 'discovery_variant_decision_invalid', details: object = {}): never => {
  throw new EngineError(code, message, { door: 'owner-variant-choice', ...details });
};
function variantResult<T>(result: OmResult<T>): T {
  if (!result.ok) throw new EngineError(result.refusal.code, result.refusal.message, result.refusal.at);
  return result.value;
}
function exactVariant<T>(store: Store, ref: Ref, kind: string): Revision<T> {
  if (!isRef(ref)) return ownerVariantInvalid(`An exact ${kind} Ref is required`, 'discovery_variant_decision_invalid', { field: kind, ref: null });
  const row = store.get<T>(ref.id, ref.revision);
  if (!row || row.kind !== kind || !same(reference(row), ref) || row.hash !== hashJson(row.value))
    return ownerVariantInvalid(`The saved exact ${kind} is missing or changed`, 'discovery_variant_decision_invalid', { field: kind, ref });
  return row;
}
function scopeOfOwner(value: VariantOwnerDecision): VariantChoiceScope {
  const { contract: _contract, authority: _authority, ...basis } = value;
  return decodeVariantChoiceScope({ action: VARIANT_OWNER_ACTION, ...basis });
}
function ownerState(value: VariantOwnerDecision, decision: Ref): VariantState {
  return decodeVariantState({ contract: VARIANT_STATE_CONTRACT, projectId: value.projectId, draft: value.draft,
    mode: value.mode, result: value.set, set: value.set, decision, previous: value.expectedSelection });
}
function variantStateProof(store: Store, project: string, ref: Ref, visiting: Set<string>): Revision<VariantState> {
  const state = exactVariant<VariantState>(store, ref, 'discovery-variant-state'), value = decodeVariantState(state.value);
  if (value.projectId !== project || state.id !== variantStateId(project, value.draft.id))
    return ownerVariantInvalid('The selection belongs to another project/draft');
  if (value.decision) {
    const decision = store.get(value.decision.id, value.decision.revision);
    if (decision?.kind === 'discovery-variant-owner-decision') {
      const proved = proveOwnerVariant(store, project, value.decision, visiting);
      if (!same(reference(proved.state), ref)) return ownerVariantInvalid('The selection is not the state of its owner act');
    } else {
      const proved = readVariantModelDecision(store, project, value.decision);
      if (!same(proved.state, ref)) return ownerVariantInvalid('The selection is not the admitted state of its paid model decision');
    }
  } else {
    const generation = readVariantGeneration(store, project, value.result);
    if (!same(generation.state, ref)) return ownerVariantInvalid('The selection has no proven paid generation application');
  }
  return state;
}
function ownerVariantBasis(store: Store, scope: VariantChoiceScope, prior: Revision<VariantState> | null): void {
  const generation = readVariantGeneration(store, scope.projectId, scope.set);
  if (generation.publication.result.kind !== 'discovery-variant-set'
    || !same(generation.publication.result.value.draft, scope.draft)
    || scope.outcome.kind === 'choose' && !generation.publication.members.some(row =>
      same(row.ref, scope.outcome.kind === 'choose' ? scope.outcome.member : null)))
    return ownerVariantInvalid('An owner act needs its exact paid set, draft and member');
  const mode = readProjectMode(store, scope.projectId, scope.mode);
  if (prior && (!same(prior.value.draft, scope.draft) || !same(prior.value.set, scope.set)))
    return ownerVariantInvalid('The expected selection belongs to another exact set/draft', 'discovery_variant_stale', { project: scope.projectId, field: 'expectedSelection', ref: scope.expectedSelection });
  if (scope.operation === 'initial') {
    if (mode.mode !== 'questions') return ownerVariantInvalid('Initial owner choice requires questions', 'discovery_variant_mode_mismatch', { field: 'mode', ref: scope.mode });
    if (!prior) return ownerVariantInvalid('Initial chooses the published current set', 'discovery_variant_stale', { field: 'expectedSelection', ref: scope.set });
    if (scope.previous !== null || prior.value.decision)
      return ownerVariantInvalid('This current set already has a choice', 'discovery_variant_conflict', { field: 'previous', ref: prior.value.decision });
  } else {
    if (!prior || !same(prior.value.decision, scope.previous))
      return ownerVariantInvalid('The previous decision must be the exact expected current choice', 'discovery_variant_stale', { project: scope.projectId, field: 'previous', ref: scope.previous });
    if (scope.operation === 'revise') {
      // The expected state was proved above, including its preceding act; do not prove the whole chain twice.
      const previous = exactVariant<VariantOwnerDecision>(store, scope.previous!, 'discovery-variant-owner-decision');
      if (!same(previous.value.set, scope.set) || !same(previous.value.draft, scope.draft))
        return ownerVariantInvalid('Owner revise retains the exact owner set and draft');
    } else {
      if (mode.mode !== 'bypass') return ownerVariantInvalid('Owner override requires bypass', 'discovery_variant_mode_mismatch', { field: 'mode', ref: scope.mode });
      const model = readVariantModelDecision(store, scope.projectId, scope.previous!);
      if (!same(model.decision.value.set, scope.set) || !same(model.decision.value.draft, scope.draft)
        || !same(model.state, reference(prior)) || readProjectMode(store, scope.projectId, model.decision.value.mode).mode !== 'bypass')
        return ownerVariantInvalid('Override needs the exact admitted model-bypass choice of this set');
    }
  }
}
function proveOwnerVariant(store: Store, project: string, ref: Ref, visiting: Set<string>): ProvenVariantOwnerDecision {
  const row = exactVariant<VariantOwnerDecision>(store, ref, 'discovery-variant-owner-decision');
  const value = decodeVariantOwnerDecision(row.value), scope = scopeOfOwner(value);
  if (value.projectId !== project || row.revision !== 1 || row.id !== variantRecordId(row.kind, value) || visiting.has(row.id))
    return ownerVariantInvalid('The owner act has a foreign, cyclic or changed immutable identity');
  visiting.add(row.id);
  try {
    const session = variantResult(readVariantChoiceSession(store, value.authority.session));
    const grant = variantResult(readVariantChoiceSessionGrant(store, value.authority.grant));
    if (session.value.state !== 'open' || !same(session.value.grant, reference(grant))
      || !same(session.value.scope, scope) || !same(grant.value.scope, scope))
      return ownerVariantInvalid('The saved open grant/session does not authorize the complete owner act');
    const prior = scope.expectedSelection ? variantStateProof(store, project, scope.expectedSelection, visiting) : null;
    ownerVariantBasis(store, scope, prior);
    const expected = ownerState(value, reference(row)), revision = (scope.expectedSelection?.revision ?? 0) + 1;
    const stateRef = { id: variantStateId(project, scope.draft.id), revision, hash: hashJson(expected) };
    const state = exactVariant<VariantState>(store, stateRef, 'discovery-variant-state');
    if (!same(state.value, expected)) return ownerVariantInvalid('The owner decision lost its complete atomic selection');
    return { verification: 'proven', decision: row, state, session, grant };
  } finally { visiting.delete(row.id); }
}
/** Exact historical proof, independent of today's mode/state heads, bearer registry and session liveness. */
export function readVariantOwnerDecision(store: Store, project: string, ref: Ref): ProvenVariantOwnerDecision {
  if (!(store instanceof Store) || typeof project !== 'string' || project.length === 0)
    return ownerVariantInvalid('An owner reader requires its Store and project');
  return proveOwnerVariant(store, project, ref, new Set());
}
function repeatedOwnerVariant(store: Store, scope: VariantChoiceScope): VariantOwnerOutcome | null {
  for (const row of store.list<VariantOwnerDecision>('discovery-variant-owner-decision')) {
    if (!row.id.startsWith(`discovery-variant-owner-decision:${scope.projectId}:`)) continue;
    const value = decodeVariantOwnerDecision(row.value);
    if (!same(value.set, scope.set)) continue;
    if (!same(scopeOfOwner(value), scope)) continue;
    const proved = readVariantOwnerDecision(store, scope.projectId, reference(row));
    return { decision: proved.decision, state: proved.state, repeated: true };
  }
  return null;
}
/** One owner door: a new act exercises the full authority and guards its exact open session in the same decision/state
 * transaction. An exact proven repeat only returns its saved pair; it never activates a historical selection again. */
export function answerVariantChoice(store: Store, request: unknown, authority: unknown): VariantOwnerOutcome {
  if (!(store instanceof Store)) return ownerVariantInvalid('An owner choice requires its Store');
  const scope = decodeVariantChoiceScope(request), repeated = repeatedOwnerVariant(store, scope);
  if (repeated) return repeated;
  // Runtime authority is deliberately separate from actor strings, supplied JSON and saved Ref-shaped values.
  const admission = variantResult(requireVariantChoiceAuthority(authority,
    { store, action: VARIANT_OWNER_ACTION, scope }));
  const session = variantResult(readVariantChoiceSession(store, admission.session));
  const prior = scope.expectedSelection ? variantStateProof(store, scope.projectId, scope.expectedSelection, new Set()) : null;
  ownerVariantBasis(store, scope, prior);
  const id = variantStateId(scope.projectId, scope.draft.id), head = store.get<VariantState>(id);
  if (scope.expectedSelection ? !head || !same(reference(head), scope.expectedSelection) : !!head)
    return ownerVariantInvalid('The owner selection moved since its full scope was chosen', 'discovery_variant_stale', { project: scope.projectId, field: 'expectedSelection', expected: scope.expectedSelection, actual: head ? reference(head) : null });
  const draft = exactVariant<DiscoveryDraft>(store, scope.draft, 'discovery-draft');
  const exercised = variantResult(requireVariantChoiceAuthority(authority,
    { store, action: VARIANT_OWNER_ACTION, scope }));
  const decision = decodeVariantOwnerDecision({ contract: VARIANT_OWNER_DECISION_CONTRACT, projectId: scope.projectId,
    draft: scope.draft, set: scope.set, mode: scope.mode, expectedSelection: scope.expectedSelection,
    previous: scope.previous, operation: scope.operation, outcome: scope.outcome,
    authority: { grant: session.value.grant, session: exercised.session } });
  const decisionId = variantRecordId('discovery-variant-owner-decision', decision);
  const decisionRef = { id: decisionId, revision: 1, hash: hashJson(decision) };
  const state = ownerState(decision, decisionRef);
  try {
    const records = store.writeMany<VariantOwnerDecision | VariantState>([
      { id: decisionId, kind: 'discovery-variant-owner-decision', expected: 0, value: decision },
      { id, kind: 'discovery-variant-state', expected: head?.revision ?? 0, value: state }
    ], uniqueTransactionGuards([scope.mode, scope.set, ...(scope.previous ? [scope.previous] : []), reference(draft), exercised.session,
      head ? reference(head) : { id, absent: true }]));
    return { decision: records[0] as Revision<VariantOwnerDecision>, state: records[1] as Revision<VariantState>, repeated: false };
  } catch (error) {
    if (error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code)) {
      const saved = repeatedOwnerVariant(store, scope);
      if (saved) return saved;
    }
    throw error;
  }
}
