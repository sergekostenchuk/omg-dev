import { researchCapacityProjection } from './early-research-outcome.js';
import { readResearchExecution } from './response-recovery.js';
import type { RecoverableContextSession } from './context-recovery.js';
import { packetAssessmentSubject, sameAssessmentSubject, assessmentSubjectKey, packetVariantSubject, variantCallMatches, variantTransportFields } from './continuation-packet.js';
import type { VariantSubject } from './discovery-variants.js';
import type { Store, Revision } from "../storage/store.js";
import type { ModelCall } from "../runtime/model-usage.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { canonical, digest, hashJson } from "../canonical.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";

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
