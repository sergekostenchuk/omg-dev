import type { Store } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchAnswer, ResearchTurn } from "./research-model.js";
import { canonical } from "../canonical.js";

/** Successful answers already present in fields need one payload, not two.
 * Failed proposals, evidence reads and assessments remain intact. Stored turns
 * are never changed; pending assessment replay uses the original stored action. */
export function researchHistory(store: Store, draft: DiscoveryDraft, turns: ResearchTurn[]): ResearchTurn[] {
  return turns.map(turn => {
    const action = turn.action as Record<string, unknown> | null;
    if (turn.status !== "completed" || turn.error || action?.['action'] !== "answer"
      || typeof action['question'] !== "string" || !Object.hasOwn(action, "value") || !turn.assessment) return turn;
    const question = store.get<Question>(action['question']);
    if (!question || !draft.questions.includes(question.id) || question.value.status !== "answered" || !question.value.answer) return turn;
    const answer = store.get<ResearchAnswer>(question.value.answer.id, question.value.answer.revision);
    const field = question.value.spec.field;
    if (answer?.kind !== "research-answer" || answer.hash !== question.value.answer.hash
      || canonical(answer.value.assessment) !== canonical(turn.assessment) || !Object.hasOwn(draft.fields, field)
      || canonical(action['value']) !== canonical(draft.fields[field])) return turn;
    const projected = { ...action }; delete projected['value'];
    projected['valuePointer'] = `/fields/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    return { ...turn, action: projected };
  });
}
