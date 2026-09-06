import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchAction, ResearchRun, ResearchTurn } from "./research-model.js";
import { canonical, hashJson } from "../canonical.js";
import { reference } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";

export const PLANNING_INSTRUCTION = "Choose what to read, not the substantive answer. You receive a navigation index, not all evidence. Group related independent reads in ONE {action:'read_plan',question,reads:[...]} using read_bundle, read_context, read_source, read or search. Reuse archived readings and accepted fields before requesting fresh extraction. If enough material is already available return {action:'synthesize',question}. Never accept a stage, invent evidence or answer from this index. Full criteria and original data remain at the exact archive addresses. For read_context use optional page:{offset,limit} for bounded arrays/strings. Unknowns and constraints must inform selection. Return JSON only.";
export const SYNTHESIS_INSTRUCTION = "This is the substantive-answer phase. Use the supplied working materials and saved findings to produce answer/answer_delta, or save a sourced checkpoint. If additional investigation is essential, return {action:'need_research',question,missing:[specific missing facts or contradictions]}; the engine will plan grouped reads with a small index. Do not issue single read/search actions in this phase. A reading plan or an index never proves a fact.";

export function dispatchMode(turns: Revision<ResearchTurn>[], question: Revision<Question>): "planning" | "synthesis" {
  const last = [...turns].reverse().find(t => t.value.question?.id === question.id);
  if (!last) return "planning";
  if (last.value.error && last.value.dispatchMode === "planning") return "planning";
  return (last.value.action as ResearchAction).action === "need_research" ? "planning" : "synthesis";
}

/** Queue real read actions atomically. A interrupted plan resumes its pending
 * children; completed reads are not dispatched again. */
export function queueReadingPlan(store: Store, run: Revision<ResearchRun>, parent: Revision<ResearchTurn>,
  draft: Revision<DiscoveryDraft>, question: Revision<Question>, action: Extract<ResearchAction, { action: "read_plan" }>) {
  requireCondition(action.question === question.id && new Set(action.reads.map(canonical)).size === action.reads.length,
    "reading_plan_invalid", "Reading plan must target this question without duplicate requests");
  const ids = action.reads.map((_, i) => `research-turn:${hashJson([parent.id, "read", i])}`);
  const existing = ids.map(id => store.get<ResearchTurn>(id));
  if (existing.some(Boolean)) {
    requireCondition(existing.every((child, i) => child?.value.plannedBy?.id === parent.id
      && canonical(child.value.action) === canonical(action.reads[i])), "reading_plan_conflict", "Saved reading queue does not match its issued plan");
    return { run, children: existing.map(child => reference(child!)) };
  }
  const children = action.reads.map((read, index) => ({ id: ids[index]!, kind: "research-turn", expected: 0,
    value: { run: run.id, number: run.value.turns + index + 1, action: read, assessment: null, observation: null,
      error: null, status: "pending", question: reference(question), plannedBy: reference(parent) } }));
  const saved = store.writeMany([{ id: run.id, kind: run.kind, expected: run.revision,
    value: { ...run.value, turns: run.value.turns + children.length } }, ...children],
    [reference(parent), reference(draft), reference(question), ...draft.value.inputs]);
  return { run: saved[0]! as unknown as Revision<ResearchRun>, children: saved.slice(1).map(reference) };
}
