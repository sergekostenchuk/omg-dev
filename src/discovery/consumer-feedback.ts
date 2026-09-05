import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { hashJson } from "../canonical.js";
import { reference, type Finding, type Ref } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";

export interface ConsumerFeedback {
  projectId: string; draft: Ref; questions: Ref[]; findings: Finding[];
}

/** Save the actual rejected proposal and reopen only its named fields, atomically.
 * Diagnostics are engine observations, never owner decisions or source evidence. */
export function rejectResearch(store: Store, draft: Revision<DiscoveryDraft>, findings: Finding[], guards: Ref[]): Revision<ConsumerFeedback> {
  const questions = draft.value.questions.map(id => store.get<Question>(id)!);
  requireCondition(findings.length > 0 && findings.every(finding => finding.field
    && questions.some(question => question.value.spec.field === finding.field && question.value.status === "answered")),
  "feedback_target_missing", "Consumer findings must name answered fields of this proposal");
  const affected = questions.filter(question => findings.some(finding => finding.field === question.value.spec.field));
  const value: ConsumerFeedback = { projectId: draft.value.projectId, draft: reference(draft), questions: affected.map(reference), findings };
  const id = `research-feedback:${hashJson(value)}`;
  return store.writeMany<ConsumerFeedback>([
    { id, kind: "research-feedback", expected: 0, value },
    ...affected.map(question => ({ id: question.id, kind: "question", expected: question.revision,
      value: { ...question.value, beforeHash: hashJson(draft.value.fields[question.value.spec.field]), status: "open", answer: null } })),
  ], [reference(draft), ...guards])[0]!;
}

export function consumerFeedback(store: Store, draft: DiscoveryDraft) {
  // Reopened questions retain the rejected fields until the model replaces them.
  // Only feedback on this question revision is relevant to a new invocation.
  const questions = new Map(draft.questions.map(id => [id, store.get<Question>(id)!]));
  return store.list<ConsumerFeedback>("research-feedback").filter(item => item.value.projectId === draft.projectId
    && item.value.questions.some(ref => {
      const question = questions.get(ref.id);
      return question?.value.status === "open" && question.revision === ref.revision + 1;
    })).map(item => ({ ref: reference(item), ...item.value }));
}
