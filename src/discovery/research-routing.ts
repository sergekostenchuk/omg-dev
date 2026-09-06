import type { Store, Revision } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { ReaderPilot } from './reader-pilot.js';
import { canonical } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { REFINEMENT_CONTRACT_VERSION, refinementQuestions, deferredGap } from '../graph/research-contracts.js';
import { researchScope, scopedQuestions, originalGaps } from '../graph/research-scope.js';
import { defectGaps } from '../graph/plan-defects.js';
import { layerDesignSpec, LAYER_DESIGN_VERSION } from '../graph/layer-design.js';

export function planningForQuestion(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>, pilot?: Revision<ReaderPilot> | null) {
  if (!pilot) return null;
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
    specs = [layerDesignSpec(3)];
  }
  requireCondition(specs.some(s => canonical(s) === canonical(question.value.spec)), 'research_contract_mismatch', 'Changed or forged question cannot select a mode by its field name');
  if (!pilot) return null;
  requireCondition(pilot.value.planning, 'planning_settings_missing', 'R2 continuation must retain explicit compact planning settings');
  return pilot.value.planning;
}
