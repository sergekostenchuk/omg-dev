import type { Store, Revision } from '../storage/store.js';
import { requireCondition } from '../errors.js';
import { reference } from '../pipeline/contracts.js';

export interface PhasePolicy { projectId: string; stopAfter: 'L2' | 'L3'; budgetSegment: string | null }
/** Phase permission is independent of the context/reader preset. */
export function configurePhasePolicy(store: Store, projectId: string, stopAfter: PhasePolicy['stopAfter'], budgetSegment: string | null, expected: number): Revision<PhasePolicy> {
  requireCondition(['L2', 'L3'].includes(stopAfter) && (stopAfter === 'L2' || (typeof budgetSegment === 'string' && budgetSegment.length > 0)),
    'phase_policy_invalid', 'L3 permission requires an explicit budget segment');
  const previous = phasePolicy(store, projectId);
  requireCondition(!previous?.value.budgetSegment || previous.value.budgetSegment === budgetSegment,
    'budget_segment_changed', 'A continuation cannot reset its budget by switching segments');
  const pilot = store.get<{ active: boolean }>(`reader-pilot:${projectId}`);
  requireCondition(pilot?.kind === 'reader-pilot' && pilot.value.active, 'phase_policy_invalid', 'Continuation must retain its active context preset');
  return store.writeMany<PhasePolicy>([{ id: `phase-policy:${projectId}`, kind: 'phase-policy', expected,
    value: { projectId, stopAfter, budgetSegment } }], [reference(pilot)])[0]!;
}
export function phasePolicy(store: Store, project: string): Revision<PhasePolicy> | null {
  const policy = store.get<PhasePolicy>(`phase-policy:${project}`);
  if (policy) requireCondition(policy.kind === 'phase-policy' && policy.value.projectId === project
    && ['L2', 'L3'].includes(policy.value.stopAfter) && (policy.value.stopAfter !== 'L3' || Boolean(policy.value.budgetSegment)),
  'phase_policy_invalid', 'Stored phase policy is incomplete or foreign');
  return policy;
}
