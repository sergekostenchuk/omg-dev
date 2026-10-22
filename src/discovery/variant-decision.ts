import { hashJson } from '../canonical.js';
import type { Ref } from '../pipeline/contracts.js';
import { VARIANT_SCOPE_CONTRACT, readVariantNoneStructural, readVariantSetStructural, readVariantSnapshotStructural,
  readVariantStructure, variantBasis, variantInvalid, variantNullableRef, variantOrigin, variantReason,
  variantRecordId, variantRef, variantSame, variantShape, variantText,
  projectVariantPublication, type StructuralVariantRecord, type VariantExecutionSession, type VariantOrigin, type VariantPublication,
  type VariantReason, type VariantRecordView } from './discovery-variants.js';

export const VARIANT_OWNER_DECISION_CONTRACT = 'discovery-variant-owner-decision/v1' as const;
export const VARIANT_MODEL_DECISION_CONTRACT = 'discovery-variant-model-decision/v1' as const;
export const VARIANT_STATE_CONTRACT = 'discovery-variant-state/v1' as const;
export const VARIANT_HANDOFF_CONTRACT = 'discovery-variant-handoff/v1' as const;
export const VARIANT_OWNER_ACTION = 'discovery-variant-choice' as const;
export const VARIANT_OWNER_GRANT_CONTRACT = 'owner-session-grant/v4' as const;
export const VARIANT_OWNER_SESSION_CONTRACT = 'owner-session/v4' as const;
export type VariantOutcome = { kind: 'choose'; member: Ref; reason: string } | { kind: 'reject_all'; reason: string };
export type VariantOwnerOperation = 'initial' | 'revise' | 'override';
export interface VariantDecisionBasis {
  projectId: string; draft: Ref; set: Ref; mode: Ref; expectedSelection: Ref | null;
  previous: Ref | null; outcome: VariantOutcome;
}
export interface VariantOwnerDecision extends VariantDecisionBasis {
  contract: typeof VARIANT_OWNER_DECISION_CONTRACT; operation: VariantOwnerOperation;
  authority: { grant: Ref; session: Ref };
}
export interface VariantModelDecision extends VariantDecisionBasis {
  contract: typeof VARIANT_MODEL_DECISION_CONTRACT; origin: VariantOrigin;
}
export type VariantDecision = VariantOwnerDecision | VariantModelDecision;
/** Full prospective scope of the future owner door. Decoding it does not mint authority. */
export interface VariantChoiceScope extends VariantDecisionBasis { action: typeof VARIANT_OWNER_ACTION; operation: VariantOwnerOperation }
export interface VariantState {
  contract: typeof VARIANT_STATE_CONTRACT; projectId: string; draft: Ref; mode: Ref;
  result: Ref; set: Ref | null; decision: Ref | null; previous: Ref | null;
}
export interface VariantScope {
  contract: typeof VARIANT_SCOPE_CONTRACT; projectId: string; draft: Ref; set: Ref; member: Ref; decision: Ref; mode: Ref;
}
export interface VariantHandoff {
  contract: typeof VARIANT_HANDOFF_CONTRACT; projectId: string; draft: Ref; frame: Ref; plan: Ref;
  snapshot: Ref | null; result: Ref | null; set: Ref | null; decision: Ref | null; scope: Ref | null;
  choice: Ref | null; reason: 'choose' | 'reject_all' | 'no_variants' | 'early_limit';
  next: 'deep' | 'dossier'; stop: VariantReason | null;
}
const decisionFields = ['contract', 'projectId', 'draft', 'set', 'mode', 'expectedSelection', 'previous', 'outcome'];
const decisionError = (field: string, message: string): never => variantInvalid(field, message, 'discovery_variant_decision_invalid');
function outcome(value: unknown): asserts value is VariantOutcome {
  variantShape(value, ['kind', 'reason', ...(typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'choose' ? ['member'] : [])], 'outcome');
  if (value.kind !== 'choose' && value.kind !== 'reject_all') decisionError('outcome.kind', 'Choose or reject an existing exact set');
  variantText(value.reason, 'outcome.reason');
  if (value.kind === 'choose') variantRef(value.member, 'outcome.member');
}
function basis(value: Record<string, unknown>, contract: string) {
  variantBasis(value, contract); variantRef(value.set, 'set'); variantRef(value.mode, 'mode');
  variantNullableRef(value.expectedSelection, 'expectedSelection'); variantNullableRef(value.previous, 'previous'); outcome(value.outcome);
}
function operation(value: Record<string, unknown>) {
  if (typeof value.operation !== 'string' || !['initial', 'revise', 'override'].includes(value.operation))
    decisionError('operation', 'Unknown owner operation');
  if ((value.operation === 'initial') !== (value.previous === null)) decisionError('previous', 'Initial has no previous decision; revise and override require one');
}
export function decodeVariantOwnerDecision(value: unknown): VariantOwnerDecision {
  variantShape(value, [...decisionFields, 'operation', 'authority'], 'ownerDecision', 'discovery_variant_decision_invalid');
  basis(value, VARIANT_OWNER_DECISION_CONTRACT); operation(value);
  variantShape(value.authority, ['grant', 'session'], 'authority');
  variantRef(value.authority.grant, 'authority.grant'); variantRef(value.authority.session, 'authority.session');
  return structuredClone(value) as unknown as VariantOwnerDecision;
}
export function decodeVariantModelDecision(value: unknown): VariantModelDecision {
  variantShape(value, [...decisionFields, 'origin'], 'modelDecision', 'discovery_variant_decision_invalid');
  basis(value, VARIANT_MODEL_DECISION_CONTRACT); variantOrigin(value.origin, 'origin');
  if (value.previous !== null) decisionError('previous', 'A model does not revise a saved choice of the same set');
  return structuredClone(value) as unknown as VariantModelDecision;
}
export function decodeVariantChoiceScope(value: unknown): VariantChoiceScope {
  variantShape(value, ['action', 'projectId', 'draft', 'set', 'mode', 'expectedSelection', 'previous', 'outcome', 'operation'], 'ownerScope');
  if (value.action !== VARIANT_OWNER_ACTION) decisionError('action', 'A different owner action cannot choose a variant');
  variantText(value.projectId, 'projectId'); variantRef(value.draft, 'draft'); variantRef(value.set, 'set'); variantRef(value.mode, 'mode');
  variantNullableRef(value.expectedSelection, 'expectedSelection'); variantNullableRef(value.previous, 'previous'); outcome(value.outcome); operation(value);
  return structuredClone(value) as unknown as VariantChoiceScope;
}
export function decodeVariantState(value: unknown): VariantState {
  variantShape(value, ['contract', 'projectId', 'draft', 'mode', 'result', 'set', 'decision', 'previous'], 'state');
  variantBasis(value, VARIANT_STATE_CONTRACT); variantRef(value.mode, 'mode'); variantRef(value.result, 'result');
  for (const field of ['set', 'decision', 'previous']) variantNullableRef(value[field], field);
  if (value.set === null && value.decision !== null) decisionError('decision', 'no_variants cannot have a choice');
  if (value.set !== null && !variantSame(value.set, value.result)) decisionError('result', 'The generation result is the exact current set');
  return structuredClone(value) as unknown as VariantState;
}
export function decodeVariantScope(value: unknown): VariantScope {
  variantShape(value, ['contract', 'projectId', 'draft', 'set', 'member', 'decision', 'mode'], 'scope');
  variantBasis(value, VARIANT_SCOPE_CONTRACT);
  for (const key of ['set', 'member', 'decision', 'mode']) variantRef(value[key], key);
  return structuredClone(value) as unknown as VariantScope;
}
export function decodeVariantHandoff(value: unknown): VariantHandoff {
  variantShape(value, ['contract', 'projectId', 'draft', 'frame', 'plan', 'snapshot', 'result', 'set', 'decision', 'scope', 'choice', 'reason', 'next', 'stop'], 'handoff');
  variantBasis(value, VARIANT_HANDOFF_CONTRACT); variantRef(value.frame, 'frame'); variantRef(value.plan, 'plan');
  for (const key of ['snapshot', 'result', 'set', 'decision', 'scope', 'choice']) variantNullableRef(value[key], key);
  if (value.stop !== null) variantReason(value.stop, 'stop');
  if (value.reason === 'choose') {
    if (value.next !== 'deep' || value.stop !== null || ['snapshot', 'result', 'set', 'decision', 'scope', 'choice'].some(key => value[key] === null))
      decisionError('handoff', 'A deep handoff requires the exact selected scope and choice');
  } else if (value.reason === 'reject_all') {
    if (value.next !== 'dossier' || value.stop !== null || value.snapshot === null || value.result === null || value.set === null
      || value.decision === null || value.scope !== null || value.choice !== null) decisionError('handoff', 'reject_all retains its set and decision');
  } else if (value.reason === 'no_variants') {
    if (value.next !== 'dossier' || value.stop !== null || value.snapshot === null || value.result === null
      || value.set !== null || value.decision !== null || value.scope !== null || value.choice !== null)
      decisionError('handoff', 'no_variants retains its negative result without a fictitious choice');
  } else if (value.reason === 'early_limit') {
    if (value.next !== 'dossier' || value.stop === null || value.decision !== null || value.scope !== null || value.choice !== null)
      decisionError('handoff', 'An early limit retains its addressed cause, not a decision');
  } else decisionError('reason', 'Unknown handoff reason');
  return structuredClone(value) as unknown as VariantHandoff;
}
export function variantStateId(projectId: string, draftId: string): string {
  return `discovery-variant-state:${hashJson({ projectId, draftId })}`;
}

export function readVariantDecisionStructural(view: VariantRecordView, project: string, ref: Ref): StructuralVariantRecord<VariantDecision> {
  variantRef(ref, 'decision');
  if (!view || typeof view.get !== 'function') decisionError('view', 'An exact record reader is required');
  const row = view.get(ref.id, ref.revision);
  let result: StructuralVariantRecord<VariantDecision>;
  if (row?.kind === 'discovery-variant-owner-decision')
    result = readVariantStructure(view, ref, project, row.kind, decodeVariantOwnerDecision);
  else if (row?.kind === 'discovery-variant-model-decision')
    result = readVariantStructure(view, ref, project, row.kind, decodeVariantModelDecision);
  else return decisionError('decision', 'Expected an exact owner or model decision record');
  const decision = result.record.value, set = readVariantSetStructural(view, project, decision.set).record.value;
  if (!variantSame(decision.draft, set.draft)) decisionError('draft', 'Decision and set belong to different drafts');
  if (decision.outcome.kind === 'choose' && !set.members.some(member => variantSame(member, decision.outcome.kind === 'choose' ? decision.outcome.member : null)))
    decisionError('outcome.member', 'Choice is not an exact member of this set');
  if (decision.contract === VARIANT_OWNER_DECISION_CONTRACT && decision.previous) {
    const kind = decision.operation === 'override' ? 'discovery-variant-model-decision' : 'discovery-variant-owner-decision';
    // Decode only the preceding immutable record; no recursion, current-head lookup or claim of authority.
    const prior = kind === 'discovery-variant-model-decision'
      ? readVariantStructure(view, decision.previous, project, kind, decodeVariantModelDecision).record.value
      : readVariantStructure(view, decision.previous, project, kind, decodeVariantOwnerDecision).record.value;
    if (!variantSame(prior.set, decision.set) || !variantSame(prior.draft, decision.draft)
      || prior.outcome.kind === 'choose' && !set.members.some(member => variantSame(member,
        prior.outcome.kind === 'choose' ? prior.outcome.member : null)))
      decisionError('previous', 'Owner revision preserves a structurally valid choice of the exact set and draft');
  }
  return result;
}
export function readVariantStateStructural(view: VariantRecordView, project: string, draft: string, ref: Ref) {
  const result = readVariantStructure(view, ref, project, 'discovery-variant-state', decodeVariantState, variantStateId(project, draft));
  const state = result.record.value;
  if (state.draft.id !== draft) decisionError('draft', 'State belongs to another logical draft');
  const generation = state.set ? readVariantSetStructural(view, project, state.set).record
    : readVariantNoneStructural(view, project, state.result).record;
  if (!variantSame(generation.value.draft, state.draft)) decisionError('draft', 'State and generation have different drafts');
  if (state.decision) {
    const decision = readVariantDecisionStructural(view, project, state.decision).record.value;
    if (!variantSame(decision.set, state.set) || !variantSame(decision.mode, state.mode)) decisionError('decision', 'State names another selection or mode');
  }
  if (state.previous) {
    const prior = readVariantStructure(view, state.previous, project, 'discovery-variant-state', decodeVariantState, variantStateId(project, draft)).record;
    if (prior.value.draft.id !== draft || prior.revision !== result.record.revision - 1) decisionError('previous', 'State names its immediate previous revision');
  } else if (result.record.revision !== 1) decisionError('previous', 'A later state must retain its previous exact revision');
  return result;
}
export function readVariantScopeStructural(view: VariantRecordView, project: string, ref: Ref) {
  const result = readVariantStructure(view, ref, project, 'discovery-variant-scope', decodeVariantScope), scope = result.record.value;
  const decision = readVariantDecisionStructural(view, project, scope.decision).record.value;
  if (decision.outcome.kind !== 'choose' || !variantSame(decision.outcome.member, scope.member)
    || !variantSame(decision.set, scope.set) || !variantSame(decision.mode, scope.mode) || !variantSame(decision.draft, scope.draft))
    decisionError('scope', 'The scope must retain the exact selected set, member, decision, draft and mode');
  return result;
}
export function readVariantHandoffStructural(view: VariantRecordView, project: string, ref: Ref) {
  const result = readVariantStructure(view, ref, project, 'discovery-variant-handoff', decodeVariantHandoff), value = result.record.value;
  if (value.snapshot) {
    const snapshot = readVariantSnapshotStructural(view, project, value.snapshot).record.value;
    if (!variantSame(snapshot.draft, value.draft) || !variantSame(snapshot.frame, value.frame) || !variantSame(snapshot.plan, value.plan))
      decisionError('snapshot', 'Handoff preserves the exact sweep basis');
  }
  if (value.result) {
    const generation = value.set ? readVariantSetStructural(view, project, value.result).record
      : readVariantNoneStructural(view, project, value.result).record;
    if (!variantSame(generation.value.snapshot, value.snapshot) || !variantSame(generation.value.draft, value.draft)
      || value.set && !variantSame(value.set, value.result)) decisionError('result', 'Handoff names another generation');
  } else if (value.set !== null) decisionError('result', 'A set cannot exist without its generation result');
  if (value.decision) {
    const decision = readVariantDecisionStructural(view, project, value.decision).record.value;
    if (!variantSame(decision.set, value.set) || decision.outcome.kind !== value.reason) decisionError('decision', 'Handoff names another decision');
  }
  if (value.scope) {
    const scope = readVariantScopeStructural(view, project, value.scope).record.value;
    if (!variantSame(scope.decision, value.decision) || !variantSame(scope.member, value.choice)) decisionError('scope', 'Handoff names another chosen scope');
  }
  return result;
}
// Keep one address formula for immutable values; the state alone has a stable project/draft address.
export { variantRecordId };

export interface VariantPublicationWrite { id: string; kind: string; expected: number; value: unknown }
/** 4B.1: the whole product batch of one paid generation — members, the set or no_variants, and the next current state —
 * as the producer writes it and the historical reader recomputes it. The previous state is the exact expected selection
 * the execution was dispatched with (absent when none); the state names the subject's exact mode and no decision yet. */
export function variantPublicationWrites(view: VariantRecordView, session: VariantExecutionSession, payload: unknown):
  { publication: VariantPublication; writes: VariantPublicationWrite[]; guards: Ref[] } {
  const publication = projectVariantPublication(session, payload), subject = session.variantSubject;
  const stateId = variantStateId(session.projectId, session.draft.id), expected = subject.expectedSelection;
  let previous: Ref | null = null, revision = 0;
  if (expected) {
    readVariantStateStructural(view, session.projectId, session.draft.id, expected);
    previous = expected; revision = expected.revision;
  }
  const isSet = publication.result.kind === 'discovery-variant-set';
  const state = decodeVariantState({ contract: VARIANT_STATE_CONTRACT, projectId: session.projectId, draft: session.draft,
    mode: subject.mode, result: publication.result.ref, set: isSet ? publication.result.ref : null, decision: null, previous });
  const writes: VariantPublicationWrite[] = [
    ...publication.members.map(member => ({ id: member.id, kind: member.kind, expected: 0, value: member.value })),
    { id: publication.result.id, kind: publication.result.kind, expected: 0, value: publication.result.value },
    { id: stateId, kind: 'discovery-variant-state', expected: revision, value: state }];
  return { publication, writes, guards: [subject.mode, ...(subject.kind === 'proposal' ? [subject.snapshot] : [])] };
}
