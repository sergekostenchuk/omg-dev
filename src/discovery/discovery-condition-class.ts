import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { acceptanceSnapshot, readAcceptedDiscoveryManifestAt, type AcceptedFinalBundle } from './discovery-acceptance.js';
import type { DiscoveryFinalAssessmentClassReview } from './discovery-final-assessment-result.js';
import { readDiscoveryFinalAssessmentPaidResultAt } from './discovery-final-assessment-execution.js';
import { V8_FINAL_CONTRACT, type FinalConditionClass } from './v7-final-contracts.js';

/** DR7 7b.3-class (codex-omg2 №16183): the historical reader of the proven class of one owner condition of an accepted
 * bundle. The class is the D7 model's own, in the explicitly versioned form discovery-final/v8 fixed by the saved
 * preparation, and it is proven only together with the really paid supported assessment of exactly that bundle, which
 * reviewed and confirmed it. A condition of the historical discovery-final/v7 form has no class: condition_class_unproven;
 * an evidence condition is never an owner choice. The reader executes no choice, publishes no edition and permits no
 * further stage. */
export const DISCOVERY_CONDITION_CLASS = 'discovery-condition-class/v1' as const;

export interface DiscoveryConditionClass {
  contract: typeof DISCOVERY_CONDITION_CLASS;
  projectId: string;
  manifest: Ref;
  conditionId: string;
  /** The exact owner condition of the accepted bundle with its options and their consequences, its class and reason. */
  condition: Record<string, unknown>;
  class: FinalConditionClass;
  classReason: string;
  /** The assessor's confirmation of this class in the paid supported assessment. */
  review: DiscoveryFinalAssessmentClassReview;
  bundle: Revision<AcceptedFinalBundle>;
  grounds: { draft: Ref; paid: Ref; assessment: Ref };
}

const same = (left: unknown, right: unknown) => canonical(left as never) === canonical(right as never);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function refuse(code: string, field: string, message: string, details: Record<string, unknown> = {}): never {
  throw new EngineError(code, `[${field}] ${message}`, { field, ...details });
}

export async function readDiscoveryConditionClassAt(store: Store, project: string, manifestRef: unknown,
  conditionId: unknown): Promise<DiscoveryConditionClass> {
  if (typeof conditionId !== 'string' || !conditionId.trim())
    refuse('discovery_condition_class_invalid', 'conditionId', 'The reader names one condition of the accepted bundle');
  const at = acceptanceSnapshot(manifestRef, 'manifest');
  const accepted = await readAcceptedDiscoveryManifestAt(store, project, at);
  const bundle = accepted.grounds.bundle;
  const condition = bundle.verdict.conditions.find(item => object(item) && item.id === conditionId) as Record<string, unknown> | undefined;
  if (!condition) refuse('discovery_condition_class_invalid', 'conditionId', 'The condition is not one of this accepted bundle', { conditionId });
  if (condition.kind !== 'owner_choice')
    refuse('discovery_condition_not_owner_choice', 'conditionId', 'An evidence condition is no owner choice and has no class', { conditionId });
  if (bundle.contract !== V8_FINAL_CONTRACT)
    refuse('discovery_condition_class_unproven', 'bundle',
      `The owner condition of a ${bundle.contract} bundle has no class; it is never read as a choice`, { conditionId });
  // The class stands only with the paid supported assessment of exactly this bundle that reviewed it.
  const paid = await readDiscoveryFinalAssessmentPaidResultAt(store, project, accepted.grounds.assessment);
  if (!paid.output || !paid.result || !same(reference(paid.output), accepted.grounds.assessment) || paid.result.verdict !== 'supported'
    || !same(paid.result.candidate, bundle))
    refuse('discovery_condition_class_unproven', 'assessment', 'The accepted bundle has no paid supported assessment of its own', { conditionId });
  const review = paid.result.result.classes?.find(item => item.conditionId === conditionId);
  if (!review || review.class !== condition.class || review.judgement !== 'confirmed')
    refuse('discovery_condition_class_unproven', 'assessment', 'The paid assessment did not confirm the class of this condition', { conditionId });
  return structuredClone({ contract: DISCOVERY_CONDITION_CLASS, projectId: project, manifest: reference(accepted.manifest), conditionId,
    condition, class: condition.class as FinalConditionClass, classReason: condition.classReason as string, review,
    bundle: accepted.bundle, grounds: { draft: accepted.grounds.draft, paid: accepted.grounds.paid, assessment: accepted.grounds.assessment } });
}
