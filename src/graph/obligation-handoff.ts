import { canonical } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import type { DiscoveryDraft } from '../discovery/discovery.js';
import type { ResearchScope } from './research-scope.js';
import { carriedObligations, type CarriedObligation } from './obligation-policy.js';
import { omObligationReadRequired, readOmObligationHandoff, type OmObligationHandoff } from './om-obligation-readers.js';

export interface LegacyObligationHandoff { r2: Ref; scope: Ref; obligations: CarriedObligation[] }
export type ObligationHandoff = LegacyObligationHandoff | OmObligationHandoff;
interface ResearchMilestone { projectId: string; phase: string; draft: Ref | null; inputs: Ref[]; carried?: CarriedObligation[] }

/** The OM producer and its explicit ledger establish their own immutable era. */
export function omObligationHandoff(store: Store, project: string, inputs: Ref[]): OmObligationHandoff | null {
  // Inputs naming no OM era are answered here — exactly what the registered
  // reader returns for them — so a bare consumer keeps its previous result
  // without the OM unit ever loading; the slot only serves OM-era requests.
  if (!omObligationReadRequired(store, project, inputs)) return null;
  const result = readOmObligationHandoff(store, project, inputs);
  if (!result.ok) throw new EngineError(result.refusal.code, result.refusal.message, result.refusal.at);
  return result.value as OmObligationHandoff | null;
}

/** Read the immutable R2 era named by the consumer, never today's policy in
 * place of an accepted historical basis. The whole handoff survives R3. */
export function obligationHandoff(store: Store, project: string, inputs: Ref[]): ObligationHandoff | null {
  const om = omObligationHandoff(store, project, inputs);
  if (om) return om;
  const r2 = inputs.find(ref => ref.id === `phase:${project}:R2`);
  const l3Ref = inputs.find(ref => ref.id === `phase:${project}:L3`);
  if (l3Ref) {
    const l3 = store.get<ResearchMilestone>(l3Ref.id, l3Ref.revision);
    requireCondition(l3?.kind === 'phase' && l3.hash === l3Ref.hash && l3.value.projectId === project,
      'obligation_handoff_foreign', 'The L3 predecessor must belong to this exact consumer basis');
    const predecessor = l3.value.inputs.find(ref => ref.id === `phase:${project}:R2`);
    requireCondition(canonical(r2 ?? null) === canonical(predecessor ?? null),
      'obligation_handoff_foreign', 'R3 cannot omit or substitute the R2 basis retained by its L3 predecessor');
  }
  if (!r2) return null; // Legacy consumers without a scoped R2 retain their era.
  const milestone = store.get<ResearchMilestone>(r2.id, r2.revision);
  requireCondition(milestone?.kind === 'phase' && milestone.hash === r2.hash
    && milestone.value.projectId === project && milestone.value.phase === 'R2',
  'obligation_handoff_foreign', 'The consumer must bind the exact R2 milestone of its own project');
  const scopeRef = milestone.value.inputs.find(ref => ref.id === `research-scope:${project}:R2`);
  if (!scopeRef) {
    requireCondition(milestone.value.carried === undefined, 'obligation_handoff_foreign', 'Carried obligations need their original scope basis');
    return null;
  }
  const scope = store.get<ResearchScope>(scopeRef.id, scopeRef.revision);
  requireCondition(scope?.kind === 'research-scope' && scope.hash === scopeRef.hash && scope.value.projectId === project,
    'obligation_handoff_foreign', 'The exact scope behind R2 is unavailable');
  if (!scope.value.policy) return null;
  const draftRef = milestone.value.draft;
  const draft = isRef(draftRef) ? store.get<DiscoveryDraft>(draftRef.id, draftRef.revision) : null;
  requireCondition(draft?.kind === 'discovery-draft' && draft.hash === draftRef!.hash && draft.value.projectId === project
    && draft.value.inputs.some(ref => canonical(ref) === canonical(scopeRef)),
  'obligation_handoff_foreign', 'A policy handoff must come from the same scope as the sealed R2 draft');
  const obligations = carriedObligations(scope);
  requireCondition(Array.isArray(milestone.value.carried) && canonical(milestone.value.carried) === canonical(obligations),
    'research_obligation_handoff_invalid', 'Every carried identity, deadline, consumer and return condition must survive R2 unchanged');
  return { r2: reference(milestone), scope: scopeRef, obligations };
}
