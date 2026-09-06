import type { Store, Revision } from "../storage/store.js";
import type { ReaderPilot } from "./reader-pilot.js";
import type { ModelCall } from "../runtime/model-usage.js";
import type { RoleBinding } from "../runtime/environment.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { canonical, digest, hashJson } from "../canonical.js";
import { reference, isRef } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { archivedContext } from "./working-context.js";

/** A local reply-size rejection does not justify buying the same generation
 * again. Reuse only a complete response to the byte-identical request, with
 * the original request ID substituted before comparing its recorded digest. */
export function replayLimitedResponse(store: Store, pilot: Revision<ReaderPilot>, role: RoleBinding,
  draftId: string, questionId: string | undefined, purpose: string, input: string) {
  const request = JSON.parse(input);
  if (!isRef(request.subject?.working?.archive)) return null;
  const calls = store.list<ModelCall>("model-call").filter(call => call.value.status === "failed"
    && call.value.error === "pilot_reply_limit" && call.value.profile?.id === pilot.id
    && call.value.projectId === pilot.value.projectId && call.value.draftId === draftId
    && call.value.questionId === (questionId ?? null) && call.value.purpose === purpose
    && call.value.requested.actor === role.actor).sort((a,b) => b.value.startedAt-a.value.startedAt || a.id.localeCompare(b.id));
  for (const call of calls) {
    const original = JSON.stringify({ ...request, requestId: call.value.requestId });
    if (digest(original) !== call.value.request.hash || original.length !== call.value.request.chars
      || Buffer.byteLength(original) !== call.value.request.bytes) continue;
    const ref = call.value.response?.record;
    requireCondition(isRef(ref), "research_replay_invalid", "The complete saved response is missing");
    const response = store.get<{ projectId: string; draftId: string; text: string }>(ref.id, ref.revision);
    requireCondition(response?.kind === "model-response" && response.hash === ref.hash
      && response.value.projectId === pilot.value.projectId && response.value.draftId === draftId,
      "research_replay_invalid", "The saved response does not match its audit record");
    const payload = JSON.parse(response.value.text);
    requireCondition(payload?.protocol === "omg-agent/v1" && payload.requestId === call.value.requestId
      && Object.hasOwn(payload, "research"), "research_replay_invalid", "The saved response has a foreign request envelope");
    requireCondition(JSON.stringify(payload.research).length <= pilot.value.maxReplyChars,
      "pilot_reply_limit", "The paid response still exceeds the reply limit; preserve it instead of regenerating");
    const draft = store.get<DiscoveryDraft>(draftId), question = questionId ? store.get<Question>(questionId) : null;
    requireCondition(draft?.kind === "discovery-draft" && draft.value.projectId === pilot.value.projectId
      && (!questionId || (question?.kind === "question" && question.value.draftId === draftId)),
      "research_replay_invalid", "The replay needs its current draft and question");
    const archive = archivedContext(store, draft, request.subject.working.archive);
    requireCondition(!question || canonical(archive.question) === canonical(reference(question)),
      "research_replay_invalid", "The saved request addresses a different question");
    const value = { projectId: pilot.value.projectId, draft: reference(draft), question: question ? reference(question) : null,
      call: reference(call), response: reference(response), profile: reference(pilot), requestHash: call.value.request.hash };
    const id = `research-response-replay:${hashJson(value)}`;
    const guards = [reference(call), reference(response), reference(pilot), reference(draft), ...draft.value.inputs,
      ...(question ? [reference(question)] : [])];
    requireCondition(guards.every(ref => {
      const current = store.get(ref.id); return current?.revision === ref.revision && current.hash === ref.hash;
    }), "input_stale", "A replay input changed");
    if (!store.get(id)) store.writeMany([{ id, kind: "research-response-replay", expected: 0, value }], guards);
    return { research: payload.research };
  }
  return null;
}
