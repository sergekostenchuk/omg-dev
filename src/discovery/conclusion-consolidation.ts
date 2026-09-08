import { canonical, type Json } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { Ref } from '../pipeline/contracts.js';
import type { ResearchAction } from './research-model.js';
import type { ReaderPilotSettings } from './reader-pilot.js';
import { compactConclusions } from './continuation-packet.js';

export interface SynthesisNote {
  checkpoint: Ref; proposal: ResearchAction; page: { offset: number; end: number };
  consolidated?: { replaces: Ref[]; format?: 2; targetChars?: number; fullTargetChars?: number; tightenedFrom?: Ref };
}

/** Replacements are engine-owned edges. The append-only session still contains
 * every original note; only its active frontier travels on the wire. */
export function activeSynthesisNotes(notes: SynthesisNote[]): SynthesisNote[] {
  if (!notes.some(note => note.consolidated)) return notes;
  const active = new Map<string, SynthesisNote>();
  for (const note of notes) {
    for (const ref of note.consolidated?.replaces ?? []) active.delete(canonical(ref));
    active.set(canonical(note.checkpoint), note);
  }
  return [...active.values()];
}
export function consolidationLimits(settings: ReaderPilotSettings) {
  const share = settings.conclusionShare ?? 0.35;
  const carry = Math.floor(settings.maxRequestChars * share);
  return { carry, target: Math.max(1, Math.min(Math.floor(settings.maxReplyChars * share), Math.floor(carry / 2))) };
}
export function consolidationNeeded(notes: SynthesisNote[], settings: ReaderPilotSettings, noMaterialRoom = false) {
  const active = activeSynthesisNotes(notes);
  // A failed compaction cannot purchase itself again, including after reopen.
  if (!active.length || active.every(note => note.consolidated?.format === 2)) return false;
  const packed = compactConclusions(active), limits = consolidationLimits(settings);
  const legacySummary = active.some(note => note.consolidated && note.consolidated.format !== 2);
  return noMaterialRoom || (legacySummary ? JSON.stringify(packed.items).length > limits.target : JSON.stringify(packed).length > limits.carry);
}

export const CONSOLIDATION_INSTRUCTION = 'Consolidate the supplied unassessed notes for the bound question. This is a notes-only step, not a material page or a final answer. Preserve every distinct finding, condition, exception, conflict, knowledge kind, owner, obligation identity and required moment. Never resolve an uncertainty by omission or inference. Return ONLY {action:"checkpoint",question:subject.question.id,value:{summaries:[{notes:[zero-based input note indexes],text:"compact findings preserving all distinct conditions"}],citationIds:[all supplied citation indexes]},citations:[],unresolved:[additional unresolved questions, if any]}. Cover every input note at least once; explicitly associate each summary with its input indexes. Cite every supplied citationId, even for conflicting or tentative findings. The engine restores the original citations and all original unresolved questions verbatim. Aim for value within subject.consolidation.targetChars; compress repetition, not meaning. Objects {refId:n} address subject.consolidation.references[n]; unresolvedIds address subject.consolidation.unresolved. Original checkpoint references remain addressable. The target applies to the complete compact items representation, including indexes and coverage; keep the text comfortably below it. A response beyond this goal is saved. Actual packet capacity governs continuation; if it does not fit, the engine permits at most one explicitly bounded tightening, never an unchanged retry loop. If an essential distinction cannot be compressed faithfully, retain it; never claim that this summary is evidence or approval.';
export const COMPACT_CHECKPOINT_INSTRUCTION = ' Keep each new checkpoint value compact (aim for at most 4000 characters). Record only new findings, exceptions and contradictions from the supplied page; do not repeat findings already in conclusions. The engine consolidates growing notes; do not omit an essential distinction merely to meet this length guide.';

export function consolidationInput(notes: SynthesisNote[], targetChars: number, format: 1 | 2 = 2) {
  const active = activeSynthesisNotes(notes), compact = compactConclusions(active, format);
  return { targetChars, notes: compact.items, citations: compact.citations, ...(format === 2 ? {references:compact.references,unresolved:compact.unresolved} : {}) };
}

/** IDs establish coverage and provenance, not semantic equivalence. The result
 * remains unassessed; final source/obligation validation and review are unchanged. */
export function consolidatedProposal(action: ResearchAction, question: string, notes: SynthesisNote[]) {
  requireCondition(action.action === 'checkpoint' && action.question === question && action.citations.length === 0,
    'consolidation_response_invalid', 'Consolidation requires a bound checkpoint with citation indexes, not invented citations or an answer');
  const value = action.value as any, input = consolidationInput(notes, 0), active = activeSynthesisNotes(notes);
  requireCondition(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'citationIds,summaries'
    && Array.isArray(value.summaries) && value.summaries.length > 0 && Array.isArray(value.citationIds),
  'consolidation_response_invalid', 'Consolidation needs explicit summaries, input coverage and all citation indexes');
  const covered = new Set<number>();
  const summaries = value.summaries.map((summary: any) => {
    requireCondition(summary && typeof summary === 'object' && Object.keys(summary).sort().join(',') === 'notes,text'
      && typeof summary.text === 'string' && summary.text.trim() && Array.isArray(summary.notes) && summary.notes.length > 0
      && new Set(summary.notes).size === summary.notes.length
      && summary.notes.every((i: any) => Number.isSafeInteger(i) && i >= 0 && i < active.length),
    'consolidation_coverage_invalid', 'Each summary must address actual input notes and retain substantive findings');
    for (const i of summary.notes) covered.add(i);
    return { checkpoints: summary.notes.map((i: number) => active[i]!.checkpoint), text: summary.text };
  });
  requireCondition(covered.size === active.length, 'consolidation_coverage_invalid', 'No input checkpoint may disappear from the summary');
  requireCondition(value.citationIds.length === input.citations.length && new Set(value.citationIds).size === input.citations.length
    && value.citationIds.every((i: any) => Number.isSafeInteger(i) && i >= 0 && i < input.citations.length),
  'consolidation_citations_invalid', 'Every original citation must survive consolidation, without substitution');
  const unresolved = [...new Set([...active.flatMap(note => note.proposal.action === 'checkpoint' ? note.proposal.unresolved : []), ...action.unresolved])];
  return { action: 'checkpoint' as const, question, value: { summaries } as Json, citations: input.citations, unresolved };
}

export interface ConsolidationNotice { code: 'consolidation_target_exceeded'; checkpoint: Ref; items: number; target: number; total: number; fullTarget: number }
export function consolidationNotice(note: SynthesisNote): ConsolidationNotice | null {
  const goal=note.consolidated; if(goal?.format!==2)return null;
  requireCondition(Number.isSafeInteger(goal.targetChars) && goal.targetChars!>0 && Number.isSafeInteger(goal.fullTargetChars) && goal.fullTargetChars!>0,
    'consolidation_state_invalid','A saved compact summary must retain its original numeric goals');
  const packed=compactConclusions([note]),items=JSON.stringify(packed.items).length,total=JSON.stringify(packed).length;
  return items<=goal.targetChars! && total<=goal.fullTargetChars! ? null : {code:'consolidation_target_exceeded',checkpoint:note.checkpoint,items,target:goal.targetChars!,total,fullTarget:goal.fullTargetChars!};
}
export const TIGHTENING_INSTRUCTION = 'This is the single bounded tightening of an already paid summary, not a fresh investigation. subject.consolidation.tightening gives the exact saved summary, current compact sizes and the remaining packet capacity. Reduce the complete compact representation by at least deficitChars; use the actual targetChars/fullTargetChars rather than an earlier stylistic goal. Remove repetition and use concise phrasing; preserve every distinct finding, condition, exception and conflict. Exact references, citations and unresolved items remain in engine dictionaries: do not repeat their metadata or unresolved text merely to preserve them. Do not read new material or claim final acceptance. Return the same checkpoint protocol described below. There will be no automatic second tightening if the resulting packet still does not fit. ';
