import { readPilotContext } from "./pilot-context.js";
import { canonical, hashJson } from "../canonical.js";
import type { ContextPage } from "./working-context.js";
import type { Store, Revision } from '../storage/store.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { ReaderPilot } from './reader-pilot.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import { requireCondition } from '../errors.js';
import type { ContextLookup } from './context-workspace.js';
import { projectResearchContextSelection } from './research-consumer-transition.js';

export function researchReadLimit(store: Store, pilot: Revision<ReaderPilot>, questionId: string, _metric: 'readChars' | 'extractedChars', _required: number, _basis: Ref[]) {
  const question=store.get<Question>(questionId);
  requireCondition(question?.kind==='question' && question.value.projectId===pilot.value.projectId,'research_question_foreign','Reads require their bound question');
  return pilot.value.maxRequestChars;
}

/** A paid packet fixes the read rule for its own application and replay. */
export function researchContextReadEra(store: Store, packet: Record<string, any> | undefined): 'legacy' | 'bounded' {
  const archiveRef = packet?.working?.archive;
  if (!isRef(archiveRef)) return 'legacy';
  const archive = store.get<{ body?: Record<string, unknown> }>(archiveRef.id, archiveRef.revision);
  requireCondition(archive?.kind === 'research-context'
    && canonical(reference(archive)) === canonical(archiveRef) && hashJson(archive.value) === archive.hash,
    'research_context_invalid', 'The paid context read lost its exact packet archive');
  const contract = archive.value.body?.contextReadContract;
  requireCondition(contract === undefined || contract === 'research-context-read/v2',
    'research_context_invalid', 'The paid context read declares an unknown delivery rule');
  return contract === 'research-context-read/v2' ? 'bounded' : 'legacy';
}

export function readResearchContext(store: Store, draft: Revision<DiscoveryDraft>, questionId: string, pilot: Revision<ReaderPilot> | undefined, ref: Ref, pointer: string, page?: ContextPage,
  mode: 'legacy' | 'bounded' = 'bounded') {
  if (mode === 'legacy') {
    const result = readPilotContext(store, draft, ref, pointer, Number.MAX_SAFE_INTEGER, page);
    const limit = pilot ? researchReadLimit(store, pilot, questionId, 'readChars', canonical(result).length, [ref]) : 300000;
    requireCondition(canonical(result).length <= limit, 'context_read_limit', 'Use a smaller addressed context page');
    return result;
  }
  const limit = pilot ? researchReadLimit(store, pilot, questionId, 'readChars', 0, [ref]) : 300000;
  const original = readPilotContext(store, draft, ref, pointer, Number.MAX_SAFE_INTEGER);
  return projectResearchContextSelection(original.value, ref, pointer, page, limit, 'bounded');
}

export function requireCurrentPriorContext(store:Store,draft:Revision<DiscoveryDraft>,result:ContextLookup){
  if(store.get(result.record.id,result.record.revision)?.kind!=='reader-result')return;
  const clipped = result as ContextLookup & { contract?: string; requested?: ContextPage;
    envelopeLimitChars?: number };
  const current = clipped.contract === 'research-context-read/v2'
    ? projectResearchContextSelection(readPilotContext(store,draft,result.record,result.pointer,
      Number.MAX_SAFE_INTEGER).value, result.record, result.pointer, clipped.requested,
      clipped.envelopeLimitChars ?? 0, 'bounded')
    : readPilotContext(store,draft,result.record,result.pointer,Number.MAX_SAFE_INTEGER,
      result.page?{offset:result.page.offset,limit:result.page.end-result.page.offset,
        ...(result.page.encoding === 'canonical-json' ? { encoding: result.page.encoding } : {})}:undefined);
  requireCondition(canonical(current)===canonical(result),'research_evidence_stale','Prior context changed before its consumer was invoked');
}
