import { Ajv } from 'ajv';
import { EngineError, requireCondition } from '../errors.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { researchAction } from './research-consumer-transition.js';

export const EARLY_RESEARCH_OUTCOME = 'early-research-outcome/v1' as const;
export const earlyResearchStage = (stage: unknown): boolean =>
  ['discovery', 'concept', 'operation-map', 'specification', 'features'].includes(String(stage));

/** Kept shared with the assessment producer: valid negative verdicts are results. */
export function requireAssessmentReply(response: any): void {
  if (response?.action === 'read_context') {
    requireCondition(researchAction(response).action === 'read_context', 'assessment_invalid', 'Expected an addressed read');
  } else if (response?.action === 'assessment_checkpoint') {
    requireCondition(Object.keys(response).sort().join(',') === 'action,notes' && Array.isArray(response.notes)
      && response.notes.every((n: unknown) => typeof n === 'string'),
    'assessment_invalid', 'Assessment checkpoint needs explicit notes');
  } else requireCondition(response && ['supported', 'insufficient', 'conflicting'].includes(response.verdict)
    && Array.isArray(response.reasons) && response.reasons.every((r: unknown) => typeof r === 'string')
    && (response.verdict === 'supported' || response.reasons.length > 0),
  'assessment_invalid', 'Expected an assessment verdict or continuation');
}
export function requireEscalationReply(response: any): void {
  requireCondition(response && typeof response.necessary === 'boolean'
    && typeof response.reason === 'string' && response.reason.trim().length > 0,
  'escalation_assessment_invalid', 'Escalation assessment requires an explicit decision and reason');
}

/** Physical ownership and packet/cursor admission must be proved by the caller.
 * This rule classifies only reply errors; it never grants a physical dispatch. */
export function earlyResearchFailure(draft: DiscoveryDraft, question: Question,
  role: 'analyst' | 'assessor' | 'escalation-assessor', payload: unknown): EngineError | null {
  requireCondition(draft && typeof draft.stage === 'string' && draft.stage && question && question.draftId && question.projectId === draft.projectId
    && Array.isArray(draft.questions) && question.spec?.schema !== undefined
    && ['analyst', 'assessor', 'escalation-assessor'].includes(role),
  'early_research_input_invalid', 'Early reply classification needs its original draft and question contract');
  if (!earlyResearchStage(draft.stage)) return null;
  try {
    if (role === 'assessor') requireAssessmentReply(payload);
    else if (role === 'escalation-assessor') requireEscalationReply(payload);
    else {
      const action = researchAction(payload);
      if (action.action === 'read_bundle' || action.action === 'answer_delta')
        throw new EngineError('reader_pilot_required', action.action === 'read_bundle'
          ? 'A source bundle needs the configured reader experiment' : 'Layer deltas require the configured experiment');
      if (action.action === 'read_plan') throw new EngineError('reading_plan_disabled', 'Grouped reading requires the planning preset');
      if (action.action === 'synthesize' || action.action === 'need_research')
        throw new EngineError('research_question_foreign', 'Mode transition must target the current question');
      if (action.action === 'answer') requireCondition(new Ajv({ strict: true, allowUnionTypes: true })
        .compile(question.spec.schema as object)(action.value), 'answer_invalid',
      'Proposed research result does not satisfy its consumer contract');
    }
  } catch (error) {
    if (error instanceof EngineError && ['research_response_invalid', 'reader_pilot_required',
      'reading_plan_disabled', 'research_question_foreign', 'answer_invalid',
      'assessment_invalid', 'escalation_assessment_invalid'].includes(error.code)) return error;
    throw error;
  }
  return null;
}

export function earlyResearchCorrection(role: 'analyst' | 'assessor' | 'escalation-assessor',
  error: EngineError, attempt: unknown, question: Question): Record<string, unknown> {
  return { contract: EARLY_RESEARCH_OUTCOME, role, attempt, code: error.code, message: error.message,
    details: error.details ?? null, responseContract: role === 'analyst'
      ? { action: 'answer', required: ['action', 'question', 'value', 'citations'], question: question.spec,
        instruction: 'Use the selected question ID, a value satisfying its schema and exact source citations. Reader/planner actions are unavailable on this stage.' }
      : role === 'assessor' ? { verdict: ['supported', 'insufficient', 'conflicting'], reasons: 'string[]',
        instruction: 'Correct only the assessment reply; preserve the supplied candidate and evidence cursor.' }
        : { necessary: 'boolean', reason: 'nonempty string', instruction: 'Correct only the escalation assessment.' } };
}
