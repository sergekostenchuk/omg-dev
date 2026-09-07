import { readPilotContext } from "./pilot-context.js";
import { canonical } from "../canonical.js";
import type { ContextPage } from "./working-context.js";
import type { Store, Revision } from '../storage/store.js';
import type { Ref } from '../pipeline/contracts.js';
import type { ReaderPilot } from './reader-pilot.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { requireCondition } from '../errors.js';

export function researchReadLimit(store: Store, pilot: Revision<ReaderPilot>, questionId: string, metric: 'readChars' | 'extractedChars', _required: number, _basis: Ref[]) {
  const question=store.get<Question>(questionId);
  requireCondition(question?.kind==='question' && question.value.projectId===pilot.value.projectId,'research_question_foreign','Reads require their bound question');
  return metric==='readChars'?pilot.value.maxReadChars:(pilot.value.maxExtractedChars??pilot.value.maxReadChars);
}

export function readResearchContext(store: Store, draft: Revision<DiscoveryDraft>, questionId: string, pilot: Revision<ReaderPilot> | undefined, ref: Ref, pointer: string, page?: ContextPage) {
  const result = readPilotContext(store, draft, ref, pointer, Number.MAX_SAFE_INTEGER, page);
  const limit = pilot ? researchReadLimit(store, pilot, questionId, 'readChars', canonical(result).length, [ref]) : 60000;
  requireCondition(canonical(result).length <= limit, 'context_read_limit', 'Use a smaller addressed context page');
  return result;
}
