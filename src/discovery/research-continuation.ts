import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchAction, ResearchTurn } from "./research-model.js";
import { Evidence, sourceIsCurrent } from "../evidence/evidence.js";
import { canonical, hashJson } from "../canonical.js";
import { reference } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { archivedContext } from "./working-context.js";

export function checkpoint(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>,
  action: Extract<ResearchAction, { action: "checkpoint" }>) {
  requireCondition(action.question === question.id && question.value.draftId === draft.id, "research_question_foreign", "Checkpoint belongs to another question");
  const observations = action.citations.map(c => new Evidence(store).observe(draft.value.projectId, c.source, c.selector));
  const value = { projectId: draft.value.projectId, draft: reference(draft), question: reference(question),
    status: "unassessed", proposal: action.value, observations, unresolved: action.unresolved };
  const id = `research-checkpoint:${hashJson(value)}`;
  return store.get(id) ?? store.writeMany([{ id, kind: "research-checkpoint", expected: 0, value }],
    [reference(draft), reference(question), ...draft.value.inputs, ...observations.map(o => o.source)])[0]!;
}

export function latestFocus(store: Store, turns: Revision<ResearchTurn>[], question: Revision<Question>) {
  for (const turn of [...turns].reverse()) {
    const observation = turn.value.observation as any;
    const reader = observation?.ref ? store.get<any>(observation.ref.id) : null;
    if (turn.value.question?.id !== question.id && reader?.value.question?.id !== question.id) continue;
    if (turn.value.status !== "completed" || turn.value.error) return null;
    if (turn.value.question && canonical(turn.value.question) !== canonical(reference(question))) return null;
    const action = (turn.value.action as { action?: string })?.action;
    const evidence = new Evidence(store);
    if (action === "read_bundle" && !observation.observations.every((o: any) => evidence.verify(o))) return null;
    if (action === "read_source" && !evidence.verify(observation)) return null;
    if (action === "read" && (!reader || canonical(reference(reader)) !== canonical(observation.ref) || !sourceIsCurrent(reader.value))) return null;
    if (action === "read_context") {
      const record = store.get(observation.record.id);
      if (!record || canonical(reference(record)) !== canonical(observation.record)) return null;
      if (record.kind === "research-context") {
        try { archivedContext(store, store.get<DiscoveryDraft>(question.value.draftId)!, observation.record); } catch { return null; }
      }
    }
    return ["read", "read_source", "read_context", "read_bundle", "search"].includes(action ?? "") ? turn.value.observation : null;
  }
  return null;
}

/** Compatibility for the saved pre-fix authority answer: append a replay, never
 * rewrite its history or reinterpret a semantic rejection as transport failure. */
export function recoverableAnswer(turns: Revision<ResearchTurn>[], question: Revision<Question>) {
  const latest = [...turns].reverse().find(turn => (turn.value.action as { question?: string })?.question === question.id
    && ["answer", "answer_delta"].includes(String((turn.value.action as { action?: string })?.action)));
  return latest?.value.status === "completed" && latest.value.error === "An input changed before the transaction could commit"
    && latest.value.assessment === null && latest.value.observation === null && latest.value.question
    && canonical(latest.value.question) === canonical(reference(question)) ? latest : null;
}
