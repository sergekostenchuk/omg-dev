import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchTurn } from "./research-model.js";
import type { ModelCall } from "../runtime/model-usage.js";
import { canonical } from "../canonical.js";
import { isRef, reference } from "../pipeline/contracts.js";
import { archivedContext } from "./working-context.js";
import { researchAction } from "./research-protocol.js";

/** Recover only a routing transcription error, using the audited request target
 * and archives bound to that exact question. Never change the selected reads,
 * accept an answer, replace history, or spend another planning call. */
export function recoverableReadingPlan(store: Store, turns: Revision<ResearchTurn>[],
  draft: Revision<DiscoveryDraft>, question: Revision<Question>) {
  const latest = turns.at(-1);
  if (!latest || latest.value.status !== "completed" || !latest.value.error
    || latest.value.dispatchMode !== "planning" || latest.value.question !== null) return null;
  const action = researchAction(latest.value.action);
  if (action.action !== "read_plan" || action.question === question.id || action.question.startsWith("question:")
    || store.get(action.question) || question.value.draftId !== draft.id) return null;
  // Arbitrary file/search requests do not establish the historical question
  // revision. All reads must prove it through their immutable context archive.
  for (const read of action.reads) {
    if (read.action !== "read_context") return null;
    try {
      const archive = archivedContext(store, draft, read.record);
      if (canonical(archive.question) !== canonical(reference(question))) return null;
    } catch { return null; }
  }
  // C52 era binding: this door repairs only the previous (legacy) chain. A
  // managed turn — or a turn descending from one through replay or queue —
  // is corrected by the new shared outcome path, never by an old-era replay.
  const managedEra = (turn: Revision<ResearchTurn> | null | undefined): boolean =>
    !!turn && (turn.id.startsWith("research-turn:v1:")
      || (turn.value as { contract?: unknown }).contract === "research-consumer-turn/v1"
      || isRef((turn.value as { consumerIntent?: unknown }).consumerIntent));
  if (managedEra(latest)) return null;
  const originRef = latest.value.replayedFrom ?? latest.value.splitFrom ?? latest.value.plannedBy;
  if (isRef(originRef) && managedEra(store.get<ResearchTurn>(originRef.id, originRef.revision))) return null;
  const matches = store.list<ModelCall>("model-call").flatMap(call => {
    const c = call.value, ref = c.response?.record;
    const callIntent = (c as { consumerIntent?: unknown }).consumerIntent;
    if (isRef(callIntent) || call.id.startsWith("model-call:consumer:v1:")) return [];
    if (c.projectId !== draft.value.projectId || c.draftId !== draft.id || c.questionId !== question.id
      || c.purpose !== "reading-planner" || c.status !== "succeeded" || !isRef(ref)) return [];
    const response = store.get<{ projectId: string; draftId: string; text: string }>(ref.id, ref.revision);
    if (response?.kind !== "model-response" || response.hash !== ref.hash || response.value.projectId !== c.projectId
      || response.value.draftId !== draft.id) return [];
    try {
      const envelope = JSON.parse(response.value.text);
      if (envelope.protocol !== "omg-agent/v1" || envelope.requestId !== c.requestId
        || canonical(envelope.research) !== canonical(action)) return [];
    } catch { return []; }
    return [{ call, response }];
  });
  if (matches.length !== 1) return null;
  const { call, response } = matches[0]!;
  return { original: latest, action: { ...action, question: question.id }, request: reference(call),
    guards: [reference(latest), reference(call), reference(response)] };
}
