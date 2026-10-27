import { EngineError } from '../errors.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { acceptanceSnapshot, provenConditionClass, readAcceptedDiscoveryBasisAt, type AcceptedFinalBundle } from './discovery-acceptance.js';
import type { DiscoveryFinalAssessmentClassReview } from './discovery-final-assessment-result.js';
import type { FinalConditionClass } from './v7-final-contracts.js';

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

export async function readDiscoveryConditionClassAt(store: Store, project: string, manifestRef: unknown,
  conditionId: unknown): Promise<DiscoveryConditionClass> {
  if (typeof conditionId !== 'string' || !conditionId.trim())
    throw new EngineError('discovery_condition_class_invalid', '[conditionId] The reader names one condition of the accepted bundle',
      { field: 'conditionId' });
  // One proof of the accepted edition and of the paid supported answer its grounds rest on; the class is proven over it.
  const { accepted, review } = await readAcceptedDiscoveryBasisAt(store, project, acceptanceSnapshot(manifestRef, 'manifest'));
  const proven = provenConditionClass(accepted.grounds.bundle, review, conditionId);
  return structuredClone({ contract: DISCOVERY_CONDITION_CLASS, projectId: project, manifest: reference(accepted.manifest), conditionId,
    condition: proven.condition, class: proven.class, classReason: proven.classReason, review: proven.review,
    bundle: accepted.bundle, grounds: { draft: accepted.grounds.draft, paid: accepted.grounds.paid, assessment: accepted.grounds.assessment } });
}
