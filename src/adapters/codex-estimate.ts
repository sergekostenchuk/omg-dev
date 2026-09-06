import type { Store } from '../storage/store.js';
import type { RoleBinding } from '../runtime/environment.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { CallEstimate } from '../runtime/research-budget.js';
import { canonical } from '../canonical.js';
import { reference } from '../pipeline/contracts.js';
import { requireCondition } from '../errors.js';

/** Empirical CLI prediction includes all reported input/output, including wrapper
 * and reasoning costs. It is explicitly not a guaranteed transport cap. */
export function estimateCliCall(store: Store, project: string, role: RoleBinding, purpose: string, chars: number): CallEstimate {
  const samples = store.list<ModelCall>('model-call').filter(c => c.value.projectId === project && c.value.purpose === purpose
    && canonical(c.value.requested) === canonical(role) && c.value.usage && c.value.request.chars > 0);
  requireCondition(samples.length > 0, 'budget_estimate_missing', 'No comparable measured calls: establish a forecast locally before dispatch');
  const tokens = Math.ceil(1.1 * Math.max(...samples.map(c => {
    const usage = c.value.usage!;
    return (usage.inputTokens + usage.outputTokens) * Math.max(1, chars / c.value.request.chars);
  })));
  return { kind: 'estimated', tokens, basis: samples.map(reference), explanation: 'Maximum comparable full input+output usage, scaled upward for the complete envelope size, plus 10%. Wrapper/reasoning included in reported usage; future provider variance and hidden calls are not bounded.' };
}

