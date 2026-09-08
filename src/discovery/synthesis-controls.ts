import type { ContextWorkspace } from './context-workspace.js';
import { requireCondition } from '../errors.js';

export interface FinalizationState { lookups: number }
export interface SynthesisControls {
  version: 2; stage: 'materials' | 'final'; mode: 'research' | 'finalization';
  remainingLookups: number | null; instruction: string;
}
export function synthesisControls(final: boolean, _workspace: ContextWorkspace, _legacyLimit: number, saved?: FinalizationState): SynthesisControls {
  requireCondition(saved === undefined || saved && Number.isSafeInteger(saved.lookups) && saved.lookups >= 0,
    'synthesis_controls_invalid', 'Finalization must preserve the number of requested lookups');
  return { version: 2, stage: final ? 'final' : 'materials', mode: final ? 'finalization' : 'research', remainingLookups: null,
    instruction: 'Distinct addressed originals are available without a lookup-count ceiling. A read_context on the final stage must state purpose: the exact missing fact or exception and why this original is needed. Use delivered originals before requesting them again. New addressed context can support an unassessed checkpoint even after all material pages. The saved lookup count is observational and never blocks a distinct necessary lookup.' };
}
export const FINAL_SYNTHESIS_INSTRUCTION = 'The current saved selections have been delivered; they may contain navigation pointers rather than primary text. Build the final answer from primary-source evidence, never from an index or an unassessed note alone. Inspect the exact stored originals before asserting their content. Return answer/answer_delta only with sufficient valid citations and required evidence. Every checkpoint finding must retain its exact primary-source citation and the association to its file range or selector. Put an uncited claim in unresolved as "нужен первичный текст: <specific claim>" rather than as a finding. Keep necessary cited context and exceptions. Do not put offset, complete or page-count bookkeeping in unresolved; the engine records progress. For a missing original already in the store, prefer {action:"read_context",record:{id,revision,hash},pointer:"/exact/pointer",page:{offset,limit},purpose:"the exact missing fact or exception"}; page is optional. Only when indispensable evidence is absent from the store, return {action:"need_research",question:subject.question.id,missing:["specific missing fact or exception"]} for the reading planner. Do not send saved originals back to fresh research merely because they are not in the current packet. Use need_owner only for unavailable owner-only information. Never invent facts, erase unresolved obligations, or reinterpret omitted history as empty. Preserve source identity, knowledge kinds, responsibilities and required moments.';
