import { readPilotContext } from "./pilot-context.js";
import { canonical } from "../canonical.js";
import type { ContextPage } from "./working-context.js";
import type { Store, Revision } from '../storage/store.js';
import type { Ref } from '../pipeline/contracts.js';
import type { ReaderPilot } from './reader-pilot.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { phasePolicy } from './phase-policy.js';
import { accommodateMetric, budgetGroups, budgetSegment } from '../runtime/research-budget.js';
import { requireCondition } from '../errors.js';

export function researchReadLimit(store: Store, pilot: Revision<ReaderPilot>, questionId: string, metric: 'readChars' | 'extractedChars', required: number, basis: Ref[]) {
  const initial = metric === 'readChars' ? pilot.value.maxReadChars : pilot.value.maxReplyChars;
  const question = store.get<Question>(questionId);
  const policy = phasePolicy(store, pilot.value.projectId);
  if (!question || question.value.level !== 'R2' || !policy) return initial;
  const draft = store.get<DiscoveryDraft>(question.value.draftId);
  requireCondition(draft, 'research_context_missing', 'Addressed reads need their saved research draft');
  const segment = budgetSegment(store, pilot.value.projectId, policy.value.budgetSegment!);
  return accommodateMetric(store, segment, budgetGroups(store, draft.id, questionId).join(','), metric, initial,
    required, draft, questionId, basis, 'Exact addressed source after duplicate-window removal exceeds the working read limit; original conditions must remain available', pilot.value.physicalLimits?.maxRequestChars);
}

export function readResearchContext(store: Store, draft: Revision<DiscoveryDraft>, questionId: string, pilot: Revision<ReaderPilot>, ref: Ref, pointer: string, page?: ContextPage) {
  const result = readPilotContext(store, draft, ref, pointer, Number.MAX_SAFE_INTEGER, page);
  const limit = researchReadLimit(store, pilot, questionId, 'readChars', canonical(result).length, [ref]);
  requireCondition(canonical(result).length <= limit, 'context_read_limit', 'Use a smaller addressed context page');
  return result;
}
