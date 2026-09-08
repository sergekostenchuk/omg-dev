import { requireCondition } from '../errors.js';

/** Normalize control-message spelling without inventing a substantive answer.
 * The model-response archive retains the original bytes; every structured fact
 * and its source hints survive as text for the existing reading planner. */
export function normalizeResearchAction(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const action = value as Record<string, unknown>;
  if (action.action !== 'need_research') return value;
  const alias = Object.hasOwn(action, 'missingFacts');
  const rich = Array.isArray(action.missing) && action.missing.some(item => typeof item !== 'string');
  const context = Object.hasOwn(action, 'reason') || Object.hasOwn(action, 'preservation');
  if (!alias && !rich && !context) return value;
  const missing: string[] = [];
  for (const field of ['missing', 'missingFacts']) {
    if (!Object.hasOwn(action, field)) continue;
    requireCondition(Array.isArray(action[field]), 'research_response_invalid', 'Missing research facts must be an array');
    for (const fact of action[field] as unknown[]) {
      requireCondition(typeof fact === 'string' ? fact.trim().length > 0
        : fact !== null && typeof fact === 'object' && !Array.isArray(fact) && Object.keys(fact).length > 0,
      'research_response_invalid', 'A missing research fact needs nonempty text or a structured description');
      missing.push(typeof fact === 'string' ? fact : JSON.stringify(fact));
    }
  }
  requireCondition(missing.length > 0, 'research_response_invalid', 'A reason alone does not identify a missing fact');
  const { missingFacts: _facts, reason, preservation, ...normalized } = action;
  if (context) {
    const details = { ...(Object.hasOwn(action, 'reason') ? {reason} : {}),
      ...(Object.hasOwn(action, 'preservation') ? {preservation} : {}) };
    missing[0] += '\nRequest context (not an additional missing fact): ' + JSON.stringify(details);
  }
  return {...normalized, missing};
}
