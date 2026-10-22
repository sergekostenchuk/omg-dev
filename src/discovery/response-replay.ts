import { researchCapacityProjection } from './early-research-outcome.js';
import { readResearchExecution } from './response-recovery.js';
import type { RecoverableContextSession } from './context-recovery.js';
import { packetAssessmentSubject, sameAssessmentSubject, assessmentSubjectKey, packetVariantSubject, variantCallMatches, variantTransportFields } from './continuation-packet.js';
import type { VariantSubject } from './discovery-variants.js';
import type { Store, Revision } from "../storage/store.js";
import type { ReaderPilot } from "./reader-pilot.js";
import type { ModelCall } from "../runtime/model-usage.js";
import type { RoleBinding } from "../runtime/environment.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchTurn } from "./research-model.js";
import { canonical, digest, hashJson } from "../canonical.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { archivedContext } from "./working-context.js";

/** A local reply-size rejection does not justify buying the same generation
 * again. Reuse only a complete response to the byte-identical request, with
 * the original request ID substituted before comparing its recorded digest. */
export function replayLimitedResponse(store: Store, pilot: Revision<ReaderPilot>, role: RoleBinding,
  draftId: string, questionId: string | undefined, purpose: string, input: string) {
  const request = JSON.parse(input);
  if (!isRef(request.subject?.working?.archive) || request.subject?.subject?.contract === 'v7-plan-subject/v1' || Object.hasOwn(request.subject, 'assessmentSubject')) return null;
  // C51 era boundary: a managed consumer call is recovered only through its
  // own intent chain; replaying its bytes here would reuse the operation key
  // without the intent binding. This path serves pre-intent calls only.
  const calls = store.list<ModelCall>("model-call").filter(call => call.value.status === "failed"
    && !Object.hasOwn(call.value, 'planAnswer') && !Object.hasOwn(call.value, 'assessmentKey')
    && !call.id.startsWith("model-call:consumer:v1:")
    && !(call.value as { consumerIntent?: unknown }).consumerIntent
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
    requireCondition(!pilot.value.physicalLimits || JSON.stringify(payload.research).length <= pilot.value.physicalLimits.maxReplyChars,
      "budget_transport_limit", "The paid response exceeds the declared physical response capacity");
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
    return { research: payload.research, call: reference(call), response: reference(response) };
  }
  return null;
}

/** C51 door: before a managed intent is paid, a byte-identical pre-intent
 * `pilot_reply_limit` call that already received its response is recovered
 * instead — the same logical step is never sent twice. Candidates are the
 * saved legacy calls for this exact pilot/draft/question/purpose/actor whose
 * stored request bytes still verify against their own recorded digest. Every
 * candidate replays through the same common validation; several
 * indistinguishable matches end in a typed refusal, never a silent pick. */
export function replayableLegacyCall(store: Store, pilot: Revision<ReaderPilot>, role: RoleBinding,
  draftId: string, questionId: string, purpose: string, runId: string):
  { research: unknown; call: Ref; response: Ref } | null {
  // A legacy call already delivered into this run's turn owns its position:
  // recoveredRequest names the exact recorded call revision (id+revision+hash
  // verified against the record, never the id alone). The replay receipt alone
  // cannot mark delivery — research-response-replay is written before the turn,
  // and the crash window between them must keep the call recoverable.
  const delivered = (call: Revision<ModelCall>) => store.list<ResearchTurn>("research-turn")
    .some(turn => turn.value.run === runId && isRef(turn.value.recoveredRequest)
      && turn.value.recoveredRequest.id === call.id
      && store.get<ModelCall>(call.id, turn.value.recoveredRequest.revision)?.hash === turn.value.recoveredRequest.hash);
  const calls = store.list<ModelCall>("model-call").filter(call => call.value.status === "failed"
    && !Object.hasOwn(call.value, 'planAnswer') && !Object.hasOwn(call.value, 'assessmentKey')
    && !call.id.startsWith("model-call:consumer:v1:")
    && !(call.value as { consumerIntent?: unknown }).consumerIntent
    && call.value.error === "pilot_reply_limit" && call.value.profile?.id === pilot.id
    && call.value.projectId === pilot.value.projectId && call.value.draftId === draftId
    && call.value.questionId === questionId && call.value.purpose === purpose
    && call.value.requested.actor === role.actor && isRef(call.value.request.record)
    && !delivered(call))
    .sort((a, b) => b.value.startedAt - a.value.startedAt || a.id.localeCompare(b.id));
  const matches: { research: unknown; call: Ref; response: Ref }[] = [];
  for (const call of calls) {
    const ref = call.value.request.record!;
    const saved = store.get<{ text: string }>(ref.id, ref.revision);
    requireCondition(saved?.kind === "model-request" && saved.hash === ref.hash,
      "research_replay_invalid", "Saved request bytes are unavailable");
    const result = replayLimitedResponse(store, pilot, role, draftId, questionId, purpose, saved.value.text);
    if (result) matches.push(result);
  }
  requireCondition(matches.length <= 1, "research_replay_invalid",
    "Several saved paid calls match this exact request");
  return matches[0] ?? null;
}

/** T owns transport replay only. A owns the assessment result and application.
 * Follow one prepared application -> its immutable running revision -> exact
 * paid wire. No lookup by Question, packet hash, progress or today's heads. */
export function replayAssessmentApplication(store: Store, session: Revision<RecoverableContextSession>,
  application: Revision<Record<string, any>>) {
  const app=application.value, expected=packetAssessmentSubject(app.context);
  if (!expected) return null;
  const bound=store.get<Record<string,any>>(application.id,2);
  if (!bound) return null;
  const fail=(condition:unknown,message:string)=>requireCondition(condition,'research_replay_invalid',message);
  fail(bound.kind===application.kind && bound.hash===hashJson(bound.value) && isRef(bound.value.call)
    && canonical(bound.value)===canonical({...app,state:'running',call:bound.value.call}),
    'The assessment application lost its exact atomic call binding');
  const origin=store.get<ModelCall>(bound.value.call.id,bound.value.call.revision);
  fail(origin?.kind==='model-call' && origin.hash===bound.value.call.hash && isRef((origin.value as any).assessmentApplication)
    && canonical((origin.value as any).assessmentApplication)===canonical(reference(application))
    && (origin.value as any).assessmentKey===assessmentSubjectKey(expected),
    'The reserved call belongs to another application or assessment subject');
  const call=store.get<ModelCall>(origin!.id);
  fail(call,'The reserved call is missing');
  requireCondition(call!.value.status!=='running','research_context_application_running',
    'Recover the in-flight physical outcome before another assessment dispatch');
  const binding=session.value.binding!;
  const draft=store.get<DiscoveryDraft>(binding.draft.id,binding.draft.revision);
  const question=store.get<Question>(binding.question.id,binding.question.revision);
  fail(draft?.hash===binding.draft.hash && question?.hash===binding.question.hash,
    'The original assessment draft and Question are unavailable');
  const paid=readResearchExecution(store,app.projectId,reference(call!),session,draft!,question!,app.role,app.profile);
  fail(paid.kind==='response','The application has no paid assessment response');
  fail(paid.prompt===researchCapacityProjection(app.context.resultCapacity,store).prompt
    && sameAssessmentSubject(paid.body,app.context) && sameAssessmentSubject(paid.subject,app.context)
    && canonical(paid.body.resultCapacity)===canonical(app.context.resultCapacity)
    && canonical(paid.subject.resultCapacity)===canonical(app.context.resultCapacity),
    'The paid context or capacity belongs to another packet or baseline');
  // Identity of the complete prepared context is checked against the immutable
  // body, not reconstructed from the current plan/baseline or caller's values.
  fail(Object.keys(app.context).every(key=>Object.hasOwn(paid.body,key)
    && canonical(paid.body[key])===canonical(app.context[key])),
    'The paid wire changed its prepared assessment context');
  return paid.kind==='response'?paid:null;
}

/** 4T3-J01 (codex-omg №11354): whether a variant call is managed is fixed by its immutable first revision — the head keeps
 * exactly the consumerIntent Ref that revision saved, or exactly its absence. A removed, added, replaced or malformed binding
 * is a typed refusal, never read as an absence. Every call is classified, not only up to the first managed one. */
export function variantCallManaged(store: Store, call: Revision<ModelCall>): boolean {
  const first = store.get<ModelCall>(call.id, 1);
  requireCondition(first?.kind === 'model-call', 'discovery_variant_origin_invalid', 'A variant call needs its first saved revision');
  const had = Object.hasOwn(first.value, 'consumerIntent'), has = Object.hasOwn(call.value, 'consumerIntent');
  const origin = (first.value as { consumerIntent?: unknown }).consumerIntent, now = (call.value as { consumerIntent?: unknown }).consumerIntent;
  requireCondition(had === has && (!had || isRef(origin) && canonical(origin) === canonical(now)), 'discovery_variant_origin_invalid',
    'A variant call keeps exactly the managed or direct origin its first revision saved');
  return had;
}

/** Every call of exactly this saved variant transport identity, direct or managed (its first packet fixes the identity). */
export function variantIdentityCalls(store: Store, projectId: string, draftId: string, questionId: string, purpose: string,
  actor: string, variant: VariantSubject): Revision<ModelCall>[] {
  const draft = store.get<DiscoveryDraft>(draftId), question = store.get<Question>(questionId);
  if (draft?.kind !== 'discovery-draft' || question?.kind !== 'question') return [];
  return store.list<ModelCall>('model-call').filter(call => call.value.projectId === projectId && call.value.purpose === purpose
    && call.value.requested?.actor === actor && canonical(packetVariantSubject(call.value)) === canonical(variant)
    && variantCallMatches(store, call, projectId, reference(draft), reference(question), purpose, actor, variant));
}

/** 4T.3: the paid answer of exactly this saved variant transport identity — project, the draft and Question edition of
 * its first packet, purpose, actor and the complete variantSubject — returns again without another payment. Only the
 * saved identity is compared: today's mode or state heads never select or replace it, and another identity never
 * receives this answer. A running call recovers first; several paid matches are a typed refusal, never a pick. */
export function replayVariantResponse(store: Store, projectId: string, draftId: string, questionId: string,
  purpose: string, actor: string, variant: VariantSubject): { research: unknown; subject: Record<string, any>; call: Ref; request: Ref; response: Ref } | null {
  const draft = store.get<DiscoveryDraft>(draftId), question = store.get<Question>(questionId);
  if (draft?.kind !== 'discovery-draft' || question?.kind !== 'question') return null;
  const own = variantIdentityCalls(store, projectId, draftId, questionId, purpose, actor, variant);
  // 4T.4: a managed call of this identity is read through its own intent, never returned or paid beside it here.
  requireCondition(!own.map(call => variantCallManaged(store, call)).includes(true), 'discovery_variant_managed',
    'This variant identity is carried by its managed intent; its result is read through that intent');
  requireCondition(!own.some(call => call.value.status === 'running'), 'continuation_call_active',
    'This variant identity has an unfinished invocation; recover its actual outcome before another dispatch');
  const paid = own.filter(call => call.value.status === 'succeeded');
  if (paid.length === 0) return null;
  requireCondition(paid.length === 1, 'research_replay_invalid', 'Several paid calls answer this exact variant identity');
  const call = paid[0]!, ref = call.value.response?.record;
  requireCondition(isRef(ref), 'research_replay_invalid', 'The paid variant call lost its complete saved response');
  const response = store.get<{ projectId: string; draftId: string; text: string }>(ref.id, ref.revision);
  requireCondition(response?.kind === 'model-response' && response.hash === ref.hash && response.hash === hashJson(response.value)
    && response.value.projectId === projectId && response.value.draftId === draftId,
  'research_replay_invalid', 'The saved variant response does not match its audit record');
  const payload = JSON.parse(response.value.text);
  requireCondition(payload?.protocol === 'omg-agent/v1' && payload.requestId === call.value.requestId && Object.hasOwn(payload, 'research'),
    'research_replay_invalid', 'The saved variant response has a foreign request envelope');
  // 4T3-01 (№11174, №11197): what this call actually sent is read back from its own saved request bytes. The request is
  // bound to the immutable first revision of the call, written before the send: the head keeps exactly that request, and
  // the bytes are read by that revision's Ref and audit — digest, chars and bytes — then the same envelope, archive and
  // transport identity the call was matched by. The archive stays the ground of the call; it is never its wire.
  const first = store.get<ModelCall>(call.id, 1);
  requireCondition(first?.kind === 'model-call' && isRef(first.value.request?.record)
    && canonical(call.value.request) === canonical(first.value.request),
  'research_replay_invalid', 'The paid variant call must keep the request its first revision saved before the send');
  const sentAudit = first.value.request, requestRef = sentAudit.record!;
  const request = store.get<{ projectId: string; draftId: string; text: string }>(requestRef.id, requestRef.revision);
  requireCondition(request?.kind === 'model-request' && canonical(reference(request)) === canonical(requestRef)
    && request.hash === hashJson(request.value) && request.value.projectId === projectId && request.value.draftId === draftId
    && typeof request.value.text === 'string' && digest(request.value.text) === sentAudit.hash
    && request.value.text.length === sentAudit.chars && Buffer.byteLength(request.value.text) === sentAudit.bytes,
  'research_replay_invalid', 'The paid variant call lost the exact saved bytes of its request');
  let wire: Record<string, any> | null;
  try { wire = JSON.parse(request.value.text); } catch { wire = null; }
  const fields = variantTransportFields(projectId, reference(draft), reference(question), purpose, actor, variant);
  const sent = wire?.subject;
  requireCondition(wire?.protocol === 'omg-agent/v1' && wire.mode === 'research' && wire.requestId === call.value.requestId
    && wire.model === call.value.requested.model && wire.effort === call.value.requested.effort
    && (wire.speed ?? 'inherited') === (call.value.requested.speed ?? 'inherited')
    && sent !== null && typeof sent === 'object' && !Array.isArray(sent)
    && canonical(sent.working?.archive ?? null) === canonical(call.value.packet!.archive)
    && Object.entries(fields).every(([key, value]) => Object.hasOwn(sent, key) && canonical(sent[key]) === canonical(value))
    && !Object.hasOwn(sent, 'subject') && !Object.hasOwn(sent, 'assessmentSubject'),
  'research_replay_invalid', 'The saved variant request belongs to another envelope or transport identity');
  return { research: payload.research, subject: sent, call: reference(call), request: reference(request), response: reference(response) };
}
