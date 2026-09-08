import { normalizeResearchAction } from './research-action-normalization.js';
import { FINAL_SYNTHESIS_INSTRUCTION } from './synthesis-controls.js';
import { CONSOLIDATION_INSTRUCTION, COMPACT_CHECKPOINT_INSTRUCTION, TIGHTENING_INSTRUCTION } from './conclusion-consolidation.js';
import { processStart } from "../runtime/process-identity.js";
import { invocationProgress, consumeInvocationAllowance } from "./invocation-progress.js";
import { requireContextDelivery } from "./context-workspace.js";
import { interceptResearchPreview } from './research-preview.js';
import type { RuntimeObservation } from '../runtime/runtime-observation-model.js';
import { continuationState, continuationDispatch, continuationMetadata, continuationPrompt } from "./continuation-packet.js";
import { estimateCliCall } from "../adapters/codex-estimate.js";
import { assertPilotBoundary, readerPilot } from "./reader-pilot.js";
import { phasePolicy } from "./phase-policy.js";
import { budgetSegment, budgetUsage, budgetGroups, assertQuestionBudget, reserveResearchCall } from "../runtime/research-budget.js";
import { planningForQuestion } from "./research-routing.js";
import { researchScope } from "../graph/research-scope.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";
import { runProcess } from "../runtime/process.js";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import { EngineError, requireCondition } from "../errors.js";
import type { ResearchAction } from "./research-model.js";
import type { Store, Revision } from "../storage/store.js";
import { tokenUsage, type ModelCall } from "../runtime/model-usage.js";
import { digest, hashJson } from "../canonical.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { pilotDispatch } from "./pilot-budget.js";
import type { ReaderPilot } from "./reader-pilot.js";
import { DELTA_COLLECTIONS } from "./layer-delta.js";
import { workingContext } from "./working-context.js";
import { replayLimitedResponse } from "./response-replay.js";
import { captureCallRuntime, finishCallRuntime } from '../runtime/call-runtime.js';
import { recoveryDispatchBoundary, operatorReplayedResponse } from './response-recovery.js';

const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const text = { type: "string", minLength: 1 };
const ref = object({ id: text, revision: { type: "integer", minimum: 1 }, hash: { type: "string", pattern: "^[a-f0-9]{64}$" } });
const selector = { oneOf: [object({ kind: { const: "json-pointer" }, pointer: { type: "string" } }),
  object({ kind: { const: "text-range" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } })] };
const deltaCollections = (items: object) => ({ type: "object", additionalProperties: false,
  properties: Object.fromEntries(DELTA_COLLECTIONS.map(key => [key, { type: "array", items }])) });
const bundleItem = (properties: Record<string, unknown>) => {
  const schema = object(properties);
  schema.properties['range'] = object({ start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 } });
  return schema;
};
const contextRead = object({ action: { const: "read_context" }, record: ref, pointer: { type: "string" } });
contextRead.properties['purpose'] = text;
contextRead.properties['page'] = object({ offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } });
const readSchemas = [
  object({ action: { const: "read_bundle" }, purpose: text, inputs: { type: "array", minItems: 1, items: { oneOf: [
    bundleItem({ path: text, media: { enum: ["text/plain", "application/json"] } }), bundleItem({ source: ref }),
  ] } } }), contextRead,
  object({ action: { const: "search" }, query: text }),
  object({ action: { const: "read_source" }, source: ref, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } }),
  object({ action: { const: "read" }, path: text, media: { enum: ["text/plain", "application/json"] } }),
];
const answerDelta = object({ action: { const: "answer_delta" }, question: text, base: ref,
  upserts: deltaCollections({ type: "object", required: ["id"], properties: { id: text } }), removes: deltaCollections(text),
  citations: { type: "array", minItems: 1, items: object({ source: ref, selector }) } });
answerDelta.properties['revises'] = ref;
answerDelta.properties['horizon'] = { type: 'array', minItems: 1, uniqueItems: true, items: text };
const validate = new Ajv({ allErrors: true }).compile<ResearchAction>({ oneOf: [
  ...readSchemas,
  object({ action: { const: "read_plan" }, question: text, reads: { type: "array", minItems: 1, maxItems: 16, items: { oneOf: readSchemas } } }),
  object({ action: { const: "synthesize" }, question: text }),
  object({ action: { const: "need_research" }, question: text, missing: { type: "array", minItems: 1, items: text } }),
  answerDelta,
  object({ action: { const: "checkpoint" }, question: text, value: {},
    citations: { type: "array", items: object({ source: ref, selector }) }, unresolved: { type: "array", items: text } }),
  object({ action: { const: "answer" }, question: text, value: {}, citations: { type: "array", minItems: 1, items: object({ source: ref, selector }) } }),
  object({ action: { const: "need_owner" }, question: text, reason: text, searched: { type: "array", minItems: 1, items: ref } }),
  object({ action: { const: "pause" }, reason: text }),
] });
export function researchAction(value: unknown): ResearchAction {
  value = normalizeResearchAction(value);
  if (!validate(value)) throw new EngineError("research_response_invalid", "Research action has missing or invalid fields", validate.errors);
  if (value.action === 'checkpoint' && value.citations.length === 0) {
    const note = value.value;
    const meaningful = typeof note === 'string' ? note.trim().length > 0 : Array.isArray(note) ? note.length > 0
      : note !== null && (typeof note !== 'object' || Object.keys(note).length > 0);
    requireCondition(meaningful || value.unresolved.some(text => text.trim().length > 0),
      'research_checkpoint_empty', 'An uncited checkpoint needs actual proposed content or an explicit unresolved question');
  }
  return value;
}
export async function researchCall(role: RoleBinding, environment: Environment, prompt: string, context: unknown, signal?: AbortSignal,
  audit?: { store: Store; draftId: string; purpose: string; questionId?: string; pilot?: Revision<ReaderPilot>;
    session?: Ref; onContext?: (context: Record<string, any>) => void }): Promise<unknown> {
  recoveryDispatchBoundary();
  const draft = audit?.store.get<DiscoveryDraft>(audit.draftId);
  const policy = audit ? phasePolicy(audit.store, environment.projectId) : null;
  let segment = null;
  let groups: string[] = [];
  let protectedQuestion: Revision<Question> | null = null;
  if (audit && draft?.value.stage === "om-g2") {
    const phase = draft.value.consumer !== "compilation" && draft.value.level === "R2" ? "L3" : draft.value.level;
    assertPilotBoundary(audit.store, environment.projectId, phase);
    if (draft.value.level === "R2" && policy) {
      const current = readerPilot(audit.store, environment.projectId);
      requireCondition(current && audit.pilot && hashJson(reference(current)) === hashJson(reference(audit.pilot)),
        "phase_protections_missing", "Every R2 role must use the current protected preset");
      const question = audit.store.get<Question>(audit.questionId ?? "");
      requireCondition(question, "budget_question_missing", "Every R2 role needs its logical question");
      protectedQuestion = question;
      planningForQuestion(audit.store, draft, question, current);
      const scope = researchScope(audit.store, environment.projectId);
      requireCondition(scope && draft.value.inputs.some(ref => hashJson(ref) === hashJson(reference(scope))),
        "research_scope_stale", "R2 requires its current explicit research scope");
      segment = budgetSegment(audit.store, environment.projectId, policy.value.budgetSegment!);
      groups = budgetGroups(audit.store, draft.id, question.id);
      assertQuestionBudget(audit.store, segment, groups);
      requireCondition(budgetUsage(audit.store, segment).measured <= segment.value.limit, "budget_actual_overrun", "An actual segment overrun requires an owner decision before continuation, including replay");
    }
  }
  requireCondition(!draft || Boolean(audit?.questionId), "continuation_question_missing", "A saved research draft cannot bypass the common packer by omitting its question");
  const packetState = audit?.questionId && draft ? continuationState(audit.store, environment.projectId, audit.draftId,
    audit.questionId, audit.purpose, role.actor) : null;
  const requestId = randomUUID();
  const consolidating = (context as any)?.dispatchMode === 'consolidation';
  const controls = (context as any)?.contextControls;
  const finalizing = !consolidating && controls?.mode === 'finalization';
  const envelope = { protocol: "omg-agent/v1", requestId, mode: "research", model: role.model,
    effort: role.effort, ...(role.speed ? { speed: role.speed } : {}), prompt: consolidating ? ((context as any)?.consolidation?.tightening ? TIGHTENING_INSTRUCTION : '') + CONSOLIDATION_INSTRUCTION : finalizing ? FINAL_SYNTHESIS_INSTRUCTION : packetState && !packetState.initial ? continuationPrompt(audit!.purpose) + (audit!.purpose === 'analyst' ? COMPACT_CHECKPOINT_INSTRUCTION : '') : prompt };
  const requestLimit = audit?.pilot?.value.maxRequestChars ?? 300000;
  const overhead = Math.max(JSON.stringify({ ...envelope, subject: {} }).length,
    controls?.version === 2 && !consolidating ? JSON.stringify({...envelope,prompt:FINAL_SYNTHESIS_INSTRUCTION,subject:{}}).length : 0) + (packetState ? 4000 : 0);
  const subject = packetState ? workingContext(audit!.store, environment.projectId, audit!.draftId, audit!.questionId!, context,
    requestLimit - overhead, { common: true, continuation: !packetState.initial, ...(packetState.latest ? {previous:packetState.latest} : {}),
      ...(audit!.pilot?{contextChars:audit!.pilot.value.maxRequestChars}:{}),
      ...(audit!.pilot?{extractedChars:audit!.pilot.value.maxRequestChars}:{}) }) : context;
  if (packetState) (subject as any).continuation = continuationMetadata(packetState, (subject as any).working.archive);
  if (!consolidating && context && typeof context==='object' && Object.hasOwn(context,'contextWorkspace'))
    requireContextDelivery((context as any).contextWorkspace,subject as Record<string,any>);
  audit?.onContext?.(subject as Record<string, any>);
  if (!consolidating && (subject as any)?.contextControls?.mode === 'finalization') envelope.prompt = FINAL_SYNTHESIS_INSTRUCTION;
  const input = JSON.stringify({ ...envelope, subject });
  requireCondition(input.length <= requestLimit, packetState?.initial === false ? "continuation_packet_limit" : "pilot_request_limit", "Full envelope exceeds its fixed transport budget; split the piece, never raise the ceiling");
  requireCondition(!audit?.pilot?.value.physicalLimits || input.length <= audit.pilot.value.physicalLimits.maxRequestChars,
    "budget_transport_limit", "The full envelope exceeds the declared physical transport capacity; split the material before dispatch");
  const recovered = operatorReplayedResponse(role, input, audit);
  if (recovered) { audit?.onContext?.(recovered.subject); return recovered.research; }
  interceptResearchPreview(input,{limit:requestLimit,draft:audit?.draftId??'',question:audit?.questionId??'',purpose:audit?.purpose??''});
  if (audit?.pilot && packetState) {
    const previous = audit.store.list<ModelCall>("model-call").filter(c => c.value.status === "failed" && c.value.error === "pilot_reply_limit"
      && c.value.questionId === audit.questionId && c.value.purpose === audit.purpose && c.value.requested.actor === role.actor
      && c.value.packet?.archive.hash === (subject as any).working.archive.hash && c.value.request.record);
    for (const call of previous) {
      const ref = call.value.request.record!;
      const saved = audit.store.get<{text:string}>(ref.id, ref.revision);
      requireCondition(saved?.hash === ref.hash, "research_replay_invalid", "Saved request bytes are unavailable");
      const paid = replayLimitedResponse(audit.store, audit.pilot, role, audit.draftId, audit.questionId, audit.purpose, saved.value.text);
      if (paid) { audit.onContext?.(JSON.parse(saved.value.text).subject); return paid.research; }
    }
  }
  const replay = audit?.pilot ? replayLimitedResponse(audit.store, audit.pilot, role, audit.draftId,
    audit.questionId, audit.purpose, input) : null;
  if (replay) return replay.research;
  const progressContext = (subject as any)?.contextControls ? {...context as Record<string,any>,contextControls:(subject as any).contextControls} : context;
  const progress=packetState?invocationProgress(audit!.store,audit!.questionId!,audit!.purpose,progressContext as Record<string,any>):null;
  const runtime = audit && draft ? await captureCallRuntime(audit.store, draft.value, role, environment, digest(input), signal) : null;
  const reservation = !segment && audit?.pilot ? pilotDispatch(audit.store, audit.pilot, `model-call:${requestId}`, input.length) : { writes: [], guards: [] };
  const estimate = segment && audit ? estimateCliCall(audit.store, environment.projectId, role, audit.purpose, input.length, packetState?.initial === false ? "continuation" : "initial") : null;
  if (segment && audit && estimate) {
    requireCondition(input.length <= requestLimit!, "pilot_request_limit", "Complete envelope exceeds its working limit");
    const reserved = reserveResearchCall(audit.store, segment, `model-call:${requestId}`, groups, estimate);
    reservation.writes.push(...reserved.writes);
    reservation.guards.push(...reserved.guards, reference(policy!), reference(audit.pilot!), reference(draft!), reference(protectedQuestion!), ...draft!.value.inputs);
  }
  if(audit){
    const projectCounterId=`project-dispatch:${hashJson(environment.projectId)}`;
    const projectCounter=audit.store.get<{projectId:string;serial:number}>(projectCounterId);
    requireCondition(!audit.store.list<RuntimeObservation>('runtime-observation').some(observation=>observation.value.projectId===environment.projectId&&observation.value.status==='running'),
      'runtime_observation_busy','Wait for the declared runtime observation before spending another model call');
    requireCondition(!projectCounter||(projectCounter.kind==='project-dispatch'&&projectCounter.value.projectId===environment.projectId
      &&Number.isSafeInteger(projectCounter.value.serial)&&projectCounter.value.serial>=0),
    'research_dispatch_invalid','Invalid project dispatch counter');
    reservation.writes.push({id:projectCounterId,kind:'project-dispatch',expected:projectCounter?.revision??0,
      value:{projectId:environment.projectId,serial:(projectCounter?.value.serial??0)+1}});
    if(projectCounter)reservation.guards.push(reference(projectCounter));
    if(policy)reservation.guards.push(reference(policy));
  }
  if (packetState) {
    const questionCounterId=`question-dispatch:${hashJson(audit!.questionId!)}`;
    const questionCounter=audit!.store.get<{projectId:string;question:string;serial:number}>(questionCounterId);
    requireCondition(!questionCounter||(questionCounter.kind==='question-dispatch'&&questionCounter.value.projectId===environment.projectId
      &&questionCounter.value.question===audit!.questionId&&Number.isSafeInteger(questionCounter.value.serial)&&questionCounter.value.serial>=0),
    'research_dispatch_invalid','Invalid question dispatch counter');
    reservation.writes.push({id:questionCounterId,kind:'question-dispatch',expected:questionCounter?.revision??0,
      value:{projectId:environment.projectId,question:audit!.questionId,serial:(questionCounter?.value.serial??0)+1}});
    if(questionCounter) reservation.guards.push(reference(questionCounter));
    if(audit!.session) reservation.guards.push(audit!.session);
    const dispatch = continuationDispatch(packetState, `model-call:${requestId}`);
    reservation.writes.push(...dispatch.writes); reservation.guards.push(...dispatch.guards,...(progress?.guards??[]));
    reservation.writes.push({id:`model-request:${requestId}`,kind:"model-request",expected:0,
      value:{projectId:environment.projectId,draftId:audit!.draftId,text:input}});
  }
  const ownerProcess=packetState?{pid:process.pid,started:processStart(process.pid)}:null;
  requireCondition(!ownerProcess||ownerProcess.started,'model_call_identity_missing','Research owner identity must be saved before dispatch');
  consumeInvocationAllowance();
  let call: Revision<ModelCall> | null = audit ? audit.store.writeMany<ModelCall>([{ id: `model-call:${requestId}`, kind: "model-call", expected: 0,
    value: { projectId: environment.projectId, draftId: audit.draftId, purpose: audit.purpose, requestId,
      ...(segment && estimate ? { budget: { segment: reference(segment), groups, estimate } } : {}),
      ...(progress?{progressKey:progress.key}:{}),
      ...(ownerProcess?{ownerProcess}:{}),
      profile: audit.pilot ? reference(audit.pilot) : null,
      questionId: audit.questionId ?? null,
      startedAt: Date.now(), finishedAt: null, status: "running", requested: role,
      ...(runtime ? { runtime } : {}),
      confirmed: { model: null, effort: null, speed: null }, request: { chars: input.length, bytes: Buffer.byteLength(input), hash: digest(input), ...(packetState ? {record:{id:`model-request:${requestId}`,revision:1,
        hash:hashJson({projectId:environment.projectId,draftId:audit.draftId,text:input})}} : {}) },
      ...(packetState ? {packet:{archive:(subject as any).working.archive,kind:packetState.initial?"initial":"continuation",maxChars:requestLimit}} : {}),
      response: null, usage: null, usageSource: "unavailable", error: null } }, ...reservation.writes], reservation.guards)[0]! : null;
  let patch: Partial<ModelCall> = {};
  let rawResponse: string | null = null;
  try {
    const result = await runProcess(role.command, environment.workspace, input, environment.timeoutMs, signal, true, pid=>{
      if(call&&audit&&packetState){const started=processStart(pid);requireCondition(started,'model_call_identity_missing','Provider identity could not be recorded');
        call=audit.store.write<ModelCall>({id:call.id,kind:call.kind,expected:call.revision,value:{...call.value,providerProcess:{pid,started}}});}
    });
    rawResponse = result.stdout;
    patch.response = { chars: result.stdout.length, bytes: Buffer.byteLength(result.stdout) };
    let response: { protocol?: unknown; requestId?: unknown; research?: unknown; usage?: unknown; confirmed?: unknown } | null = null;
    try { response = JSON.parse(result.stdout); } catch { /* Exit status and envelope are checked below. */ }
    if (response?.protocol === "omg-agent/v1" && response.requestId === requestId) {
      patch.usage = tokenUsage(response.usage); patch.usageSource = patch.usage ? "adapter" : "unavailable";
      const confirmed = response.confirmed as Record<string, unknown> | undefined;
      if (confirmed) {
        requireCondition(Object.keys(confirmed).sort().join(",") === "effort,model,speed"
          && Object.values(confirmed).every(value => value === null || (typeof value === "string" && value.length > 0)),
        "usage_invalid", "Confirmed runtime fields must be explicit strings or null");
        patch.confirmed = confirmed as ModelCall['confirmed'];
      }
    }
    requireCondition(result.exitCode === 0, "research_provider_failed", result.stderr.slice(-2000) || "Research provider failed");
    requireCondition(response, "research_response_invalid", "Research adapter must return a protocol response");
    requireCondition(response.protocol === "omg-agent/v1" && response.requestId === requestId && Object.hasOwn(response, "research"),
      "research_response_foreign", "Research response is missing or belongs to another invocation");
    requireCondition(!audit?.pilot?.value.physicalLimits || JSON.stringify(response.research).length <= audit.pilot.value.physicalLimits.maxReplyChars,
      "budget_transport_limit", "Response exceeds the declared physical response capacity");
    patch.status = "succeeded"; return response.research;
  } catch (error) {
    patch.status = "failed"; patch.error = error instanceof EngineError ? error.code : "research_call_failed"; throw error;
  } finally {
    if (call && audit) {
      const responseWrites = [];
      if (rawResponse !== null) {
        const saved = { id: `model-response:${requestId}`, kind: "model-response", expected: 0,
          value: { projectId: environment.projectId, draftId: audit.draftId, text: rawResponse } };
        responseWrites.push(saved);
        patch.response = { ...patch.response!, record: { id: saved.id, revision: 1, hash: hashJson(saved.value) } };
      }
      call = audit.store.writeMany<ModelCall>([{ id: call.id, kind: call.kind, expected: call.revision,
        value: { ...call.value, ...patch, finishedAt: Date.now(), ...(runtime?.status === 'captured'
          ? { runtime: { ...runtime, status: 'unavailable', error: 'call_runtime_finalize_pending' } } : {}) } }, ...responseWrites])[0]!;
      if (segment && budgetUsage(audit.store, segment).measured > segment.value.limit) {
        audit.store.write({ id: `budget-incident:${requestId}`, kind: "budget-incident", expected: 0,
          value: { projectId: environment.projectId, segment: reference(segment), call: reference(call), reason: "Actual provider usage exceeded the experimental forecast and the owner budget; further calls are forbidden" } });
        throw new EngineError("budget_actual_overrun", "Actual usage exceeded the owner budget; the incident is recorded and further calls are blocked");
      }
      if (segment) assertQuestionBudget(audit.store, segment, groups);
      // Persist the paid response and usage before hashing runtime files. If
      // telemetry is interrupted, accounting survives and R3 sees explicit
      // unavailable evidence; it must never trigger another paid invocation.
      if (runtime?.status === 'captured') {
        const measured = await finishCallRuntime(audit.store, environment.projectId, runtime);
        try { call = audit.store.write<ModelCall>({ id: call.id, kind: call.kind, expected: call.revision,
          value: { ...call.value, runtime: measured } }); }
        catch (error) {
          if (!(error instanceof EngineError) || !['revision_conflict', 'input_stale'].includes(error.code)) throw error;
          // A concurrent record update wins; the already saved paid result is
          // not repeated solely to complete runtime telemetry.
        }
      }
    }
  }
}
