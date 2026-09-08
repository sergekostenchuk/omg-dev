import type { ContextWorkspace } from './context-workspace.js';
import { requireCondition } from '../errors.js';

export interface FinalizationState { lookups: number }
export interface SynthesisControls {
  version: 2; stage: 'materials' | 'final'; mode: 'research' | 'finalization';
  remainingLookups: number; instruction: string;
}
export function synthesisControls(final: boolean, workspace: ContextWorkspace, limit: number, saved?: FinalizationState): SynthesisControls {
  requireCondition(saved === undefined || saved && Number.isSafeInteger(saved.lookups) && saved.lookups >= 0,
    'synthesis_controls_invalid', 'Finalization must preserve the number of requested lookups');
  const remainingLookups = Math.max(0, limit - (final ? saved?.lookups ?? workspace.sinceProgress : workspace.sinceProgress));
  return { version: 2, stage: final ? 'final' : 'materials', mode: final && remainingLookups === 0 ? 'finalization' : 'research', remainingLookups,
    instruction: 'The lookup count is engine-owned. A read_context on the final stage must state purpose: the exact missing fact or exception and why this original is needed. Do not scan the prior-evidence catalogue sequentially without a named missing basis. New addressed context can support an unassessed checkpoint even after all material pages. A checkpoint never refreshes the final-stage lookup allowance.' };
}
export const FINAL_SYNTHESIS_INSTRUCTION = 'The saved materials have all been supplied. This is one bounded finalization attempt, not another catalogue-search step. Use the exact delivered context, complete conclusion dictionaries and the bound question contract. Return answer/answer_delta only with sufficient valid citations and required evidence. You may checkpoint substantive findings from newly delivered context once; do not repeat already checkpointed findings. If indispensable repository evidence is still absent, return need_research naming the exact missing facts or exceptions for the reading planner. Use need_owner only for genuinely unavailable owner-only information. read_context is unavailable in this mode: the final-stage lookup allowance is exhausted. Never invent facts, erase unresolved obligations, or reinterpret omitted history as empty. Preserve source identity, knowledge kinds, responsibilities and required moments.';
