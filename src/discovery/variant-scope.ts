import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { Store, type Revision } from '../storage/store.js';
import { readVariantOwnerDecision, type ProvenVariantOwnerDecision } from './discovery-decision.js';
import { readProjectMode } from '../product/project-mode.js';
import { readVariantGeneration, readVariantModelDecision,
  type ProvenVariantGeneration, type ProvenVariantModelDecision } from './response-recovery.js';
import { decodeVariantScope, readVariantScopeStructural, readVariantStateStructural, variantStateId,
  type VariantOwnerDecision, type VariantModelDecision, type VariantScope, type VariantState } from './variant-decision.js';
import { VARIANT_SCOPE_CONTRACT, variantInvalid, variantRecordId, variantSame } from './discovery-variants.js';

/** 4P.1 (codex-omg №11896 п.1): the selected variant scope — the exact project/draft/set/member/decision/mode of the
 * variant a real choose actually selected. The structural scope form and its record live in variant-decision.ts and are
 * not copied here; this module adds the two missing halves. The producer mints the scope of the CURRENT proven choice
 * only — a paid model decision through readVariantModelDecision or an owner act through readVariantOwnerDecision, with
 * the chosen member an exact member of the proven paid set — and guards its one write against a move of mode or state.
 * The evidential reader proves the same lineage for any exact scope Ref independent of today's heads: a later choice
 * keeps the old scope historically provable and never reactivates it. reject_all, no_variants and a model result
 * published without its admitted state select no variant and mint no scope; a path that requires a scope receives the
 * typed discovery_variant_scope_required refusal, never a broad fallback. */
export const VARIANT_SCOPE_KIND = 'discovery-variant-scope' as const;

/** The proven choice a scope stands on: the exact decision Ref, its decoded value, the state its application wrote
 * (null when a paid model result was published stale), and the full proof of the door behind it. */
export interface ProvenVariantChoice {
  kind: 'owner' | 'model'; ref: Ref; value: VariantOwnerDecision | VariantModelDecision; state: Ref | null;
  proof: ProvenVariantOwnerDecision | ProvenVariantModelDecision;
}
export interface ProvenVariantScope {
  verification: 'proven'; scope: Revision<VariantScope>; generation: ProvenVariantGeneration; choice: ProvenVariantChoice;
}
export interface PublishedVariantScope { scope: Revision<VariantScope>; repeated: boolean }
export interface CurrentVariantScope extends ProvenVariantScope { state: Revision<VariantState> }

function scopeInvalid(field: string, message: string, ref?: Ref): never {
  return variantInvalid(field, message, 'discovery_variant_scope_invalid', ref);
}
function scopeRequired(field: string, message: string, ref?: Ref): never {
  return variantInvalid(field, message, 'discovery_variant_scope_required', ref);
}

function requireStore(store: unknown, project: unknown): void {
  if (!(store instanceof Store) || typeof project !== 'string' || project.length === 0)
    scopeInvalid('store', 'A scope reader or producer requires its Store and project');
}

/** The decision of an exact Ref proven by its own door; a structural record of either kind alone proves nothing. */
function provenChoice(store: Store, project: string, ref: Ref): ProvenVariantChoice {
  const row = isRef(ref) ? store.get(ref.id, ref.revision) : null;
  if (row?.kind === 'discovery-variant-owner-decision') {
    const proof = readVariantOwnerDecision(store, project, ref);
    return { kind: 'owner', ref, value: proof.decision.value, state: reference(proof.state), proof };
  }
  if (row?.kind === 'discovery-variant-model-decision') {
    const proof = readVariantModelDecision(store, project, ref);
    return { kind: 'model', ref, value: proof.decision.value, state: proof.state, proof };
  }
  return scopeInvalid('decision', 'A scope stands on an exact owner or model decision record', isRef(ref) ? ref : undefined);
}

function provenGeneration(store: Store, project: string, choice: ProvenVariantChoice, ref: Ref): ProvenVariantGeneration {
  const outcome = choice.value.outcome;
  if (outcome.kind !== 'choose')
    scopeRequired('outcome', 'Only a choose selects the variant a scope names; reject_all and no_variants select none', ref);
  const generation = readVariantGeneration(store, project, choice.value.set);
  if (generation.publication.result.kind !== 'discovery-variant-set'
    || !generation.publication.members.some(member => variantSame(member.ref, outcome.member)))
    scopeInvalid('member', 'The chosen member is an exact member of the decision\'s paid set', ref);
  return generation;
}

function scopeValue(project: string, choice: ProvenVariantChoice): VariantScope {
  const outcome = choice.value.outcome;
  if (outcome.kind !== 'choose')
    scopeRequired('outcome', 'Only a choose selects the variant a scope names; reject_all and no_variants select none', choice.ref);
  return decodeVariantScope({ contract: VARIANT_SCOPE_CONTRACT, projectId: project, draft: choice.value.draft,
    set: choice.value.set, member: outcome.member, decision: choice.ref, mode: choice.value.mode });
}

/** The today's-head check of the producer: the state this choice wrote is still the current selection. A repeat of a
 * moved choice never reactivates it — the historical reader keeps the old scope, the producer refuses it. */
function requireCurrentState(store: Store, project: string, choice: ProvenVariantChoice, scope: VariantScope): Revision<VariantState> {
  const stateId = variantStateId(project, scope.draft.id), head = store.get<VariantState>(stateId);
  if (choice.state === null || !head || !variantSame(reference(head), choice.state))
    throw new EngineError('discovery_variant_stale',
      'The current selection moved off this choice; a scope is minted only for the current proven choice',
      { project, field: 'decision', expected: choice.state, actual: head ? reference(head) : null });
  return head;
}

/** The evidential reader: the exact scope Ref proven through its decision door and its paid generation, independent of
 * today's mode/state heads — after a later choice the old scope stays provable and is never reactivated. A paid choice
 * whose application admitted no state (a stale model result, state=null) grounds no scope even historically. */
export function readVariantScope(store: Store, project: string, ref: Ref): ProvenVariantScope {
  requireStore(store, project);
  const record = readVariantScopeStructural(store, project, ref).record;
  const choice = provenChoice(store, project, record.value.decision);
  if (choice.state === null)
    scopeInvalid('state', 'A scope grounds a choice whose application proved its admitted state', ref);
  const generation = provenGeneration(store, project, choice, ref);
  return { verification: 'proven', scope: record, generation, choice };
}

/** The producer: one guarded write of the scope of the CURRENT proven choice. The repeat of the same current choice
 * returns its saved exact Ref and writes and pays nothing; a choice the selection moved off is refused stale. */
export function publishVariantScope(store: Store, project: string, decision: Ref): PublishedVariantScope {
  requireStore(store, project);
  const choice = provenChoice(store, project, decision);
  const value = scopeValue(project, choice);
  provenGeneration(store, project, choice, decision);
  const id = variantRecordId(VARIANT_SCOPE_KIND, value), existing = store.get<VariantScope>(id);
  if (existing) {
    const proven = readVariantScope(store, project, reference(existing));
    requireCurrentState(store, project, choice, value);
    return { scope: proven.scope, repeated: true };
  }
  const head = requireCurrentState(store, project, choice, value);
  // The guards stand on today's mode head and the exact state: a concurrent move of either aborts the write, and the
  // retry re-reads them. The scope value itself keeps the exact mode of its decision, not today's head.
  const guards = uniqueTransactionGuards([readProjectMode(store, project).ref, choice.value.set, decision, reference(head)]);
  const scope = store.writeMany<VariantScope>([{ id, kind: VARIANT_SCOPE_KIND, expected: 0, value }], guards)[0]!;
  return { scope, repeated: false };
}

/** The current exact scope a requiring path (a deep preparation) must stand on, resolved from today's state head: the
 * current decision proven by its door, its scope published and itself fully proven. A draft without a state, a negative
 * or rejected selection, or an unpublished scope is the typed discovery_variant_scope_required refusal. */
export function readCurrentVariantScope(store: Store, project: string, draft: Ref): CurrentVariantScope {
  requireStore(store, project);
  if (!isRef(draft)) scopeInvalid('draft', 'The current-scope reader needs the exact draft of the selection');
  const stateId = variantStateId(project, draft.id), head = store.get<VariantState>(stateId);
  if (!head) scopeRequired('state', 'The draft has no published variant state yet', draft);
  const state = readVariantStateStructural(store, project, draft.id, reference(head)).record;
  if (!variantSame(state.value.draft, draft))
    scopeInvalid('draft', 'The current selection stands on another exact draft revision', draft);
  if (state.value.set === null || state.value.decision === null)
    scopeRequired('decision', 'A no_variants result selects no variant', reference(head));
  const choice = provenChoice(store, project, state.value.decision);
  if (choice.state === null || !variantSame(reference(head), choice.state))
    scopeInvalid('state', 'The current head is not the state this choice\'s application proved', reference(head));
  const value = scopeValue(project, choice);
  const published = store.get<VariantScope>(variantRecordId(VARIANT_SCOPE_KIND, value));
  if (!published) scopeRequired('scope', 'The scope of the current choice is not published for the requiring path', reference(head));
  return { ...readVariantScope(store, project, reference(published)), state };
}
