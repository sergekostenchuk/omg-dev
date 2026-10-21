import type { Store, Revision } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { readerPilot, type ReaderPilot, type V7PlanningSettings } from './reader-pilot.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { packetPlanSubject, planQuestionContract } from './continuation-packet.js';
import { isDiscoveryV7Draft } from './v7-contracts.js';
import type { V7PlanSubject } from './v7-managed-attempt.js';
import type { ProducerPolicy } from './requirements.js';
import type { ResearchAnswer } from './research-model.js';
import { canonical } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { REFINEMENT_CONTRACT_VERSION, refinementQuestions, deferredGap } from '../graph/research-contracts.js';
import { researchScope, scopedQuestions, originalGaps } from '../graph/research-scope.js';
import { defectGaps } from '../graph/plan-defects.js';
import { layerDesignSpec, LAYER_DESIGN_VERSION } from '../graph/layer-design.js';
import { withTypedBasis } from '../graph/research-basis.js';
import { withObligationEvidence } from '../graph/obligation-evidence.js';
import { obligationHandoff } from '../graph/obligation-handoff.js';

export function planningForQuestion(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, pilot?: Revision<ReaderPilot> | null) {
  // A physical plan field is not the subject of one v7 attempt.
  if (!pilot || isDiscoveryV7Draft(draft.value)) return null;
  if (draft.value.level !== 'R2' || draft.value.stage !== 'om-g2') return pilot?.value.planning?.fields.includes(question.value.spec.field) ? pilot.value.planning : null;
  requireCondition(question.value.projectId === draft.value.projectId && question.value.draftId === draft.id && draft.value.questions.includes(question.id)
    && question.value.level === draft.value.level && question.value.stage === draft.value.stage && question.value.consumer === draft.value.consumer,
  'research_contract_mismatch', 'R2 routing requires a bound current question');
  let specs;
  if (draft.value.consumer === 'compilation') {
    requireCondition(draft.value.contractVersion === REFINEMENT_CONTRACT_VERSION, 'research_contract_mismatch', 'R2 needs the current technical contract');
    const scope = researchScope(store, draft.value.projectId);
    const extras = defectGaps(store, draft.value.projectId, draft.value.inputs);
    if (scope) specs = [...scopedQuestions(scope.value, extras), ...scopedQuestions(scope.value, extras, 'target-field')];
    else {
      const graph = store.get<import('../graph/model.js').Graph>(`graph:${draft.value.projectId}`)!;
      const gaps = [...originalGaps(store, draft.value.projectId).filter(g => !deferredGap(graph.value, g)), ...extras];
      specs = [...refinementQuestions('R2', gaps), ...refinementQuestions('R2', gaps, 'target-field')];
    }
  } else {
    requireCondition(draft.value.contractVersion === LAYER_DESIGN_VERSION, 'research_contract_mismatch', 'L3 needs its layer design contract');
    specs = [layerDesignSpec(3, obligationHandoff(store, draft.value.projectId, draft.value.inputs))];
  }
  if (draft.value.basisContract === 'typed-v1') specs = specs.map(withTypedBasis);
  if (draft.value.obligationContract === 'evidence-v1') specs = specs.map(withObligationEvidence);
  requireCondition(specs.some(s => canonical(s) === canonical(question.value.spec)), 'research_contract_mismatch', 'Changed or forged question cannot select a mode by its field name');
  if (!pilot) return null;
  requireCondition(pilot.value.planning, 'planning_settings_missing', 'R2 continuation must retain explicit compact planning settings');
  return pilot.value.planning;
}

/** New-work mode selection only. K/C prove the exact plan subject; paid replay
 * never calls this selector. Absence of an explicit policy or setting leaves
 * the analyst route, and planning.fields cannot opt dynamic questions in. */
export function planningForPlanSubject(store: Store, project: string, draftRef: Ref,
  subject: V7PlanSubject, producerPolicy?: ProducerPolicy,
  pilot: Revision<ReaderPilot> | null = readerPilot(store, project)): V7PlanningSettings | null {
  // The default reads through the pilot validator, including inactive settings.
  // A caller publishing new work passes its single validated snapshot so its
  // decision and transaction guards cannot refer to different settings.
  const selected = packetPlanSubject({ subject });
  requireCondition(selected, 'research_plan_subject_invalid', 'Planning requires an explicit plan subject');
  const draft = isRef(draftRef) ? store.get<DiscoveryDraft>(draftRef.id) : null;
  const answer = store.get<ResearchAnswer>(selected.planAnswer.id, selected.planAnswer.revision);
  const question = answer?.kind === 'research-answer' && typeof answer.value?.question === 'string'
    ? store.get<Question>(answer.value.question) : null;
  requireCondition(draft?.kind === 'discovery-draft' && draft.revision === draftRef.revision
    && draft.hash === draftRef.hash && draft.value?.projectId === project && isDiscoveryV7Draft(draft.value)
    && answer?.hash === selected.planAnswer.hash && answer.value?.projectId === project
    && question?.kind === 'question' && question.value?.projectId === project && question.value.draftId === draft.id
    && question.value.spec?.field === 'plan' && isRef(question.value.answer)
    && Array.isArray(draft.value.questions) && draft.value.questions.includes(question.id),
  'research_plan_subject_invalid', 'Planning requires the current exact draft and its physical Question');
  planQuestionContract(store, draft, question, selected);
  return producerPolicy?.discovery === 7 && Object.hasOwn(producerPolicy, 'discovery') && pilot?.value.v7Planning
    ? structuredClone(pilot.value.v7Planning) : null;
}
