import { estimateCliCall } from "../adapters/codex-estimate.js";
import { assertPilotBoundary, readerPilot } from "./reader-pilot.js";
import { phasePolicy } from "./phase-policy.js";
import { budgetSegment, budgetUsage, budgetGroups, reserveResearchCall, workingLimit, accommodateQuestion, accommodateMetric } from "../runtime/research-budget.js";
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
import { reference } from "../pipeline/contracts.js";
import { pilotDispatch } from "./pilot-budget.js";
import type { ReaderPilot } from "./reader-pilot.js";
import { DELTA_COLLECTIONS } from "./layer-delta.js";
import { workingContext } from "./working-context.js";
import { replayLimitedResponse } from "./response-replay.js";

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
    citations: { type: "array", minItems: 1, items: object({ source: ref, selector }) }, unresolved: { type: "array", items: text } }),
  object({ action: { const: "answer" }, question: text, value: {}, citations: { type: "array", minItems: 1, items: object({ source: ref, selector }) } }),
  object({ action: { const: "need_owner" }, question: text, reason: text, searched: { type: "array", minItems: 1, items: ref } }),
  object({ action: { const: "pause" }, reason: text }),
] });
export function researchAction(value: unknown): ResearchAction {
  if (!validate(value)) throw new EngineError("research_response_invalid", "Research action has missing or invalid fields", validate.errors);
  return value;
}
export async function researchCall(role: RoleBinding, environment: Environment, prompt: string, context: unknown, signal?: AbortSignal,
  audit?: { store: Store; draftId: string; purpose: string; questionId?: string; pilot?: Revision<ReaderPilot>;
    onContext?: (context: Record<string, any>) => void }): Promise<unknown> {
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
    }
  }
  const requestId = randomUUID();
  const envelope = { protocol: "omg-agent/v1", requestId, mode: "research", model: role.model,
    effort: role.effort, ...(role.speed ? { speed: role.speed } : {}), prompt };
  const initialRequestLimit = audit?.purpose === "reading-planner" && audit.pilot?.value.planning
    ? audit.pilot.value.planning.maxRequestChars : audit?.pilot?.value.maxRequestChars;
  let requestLimit = segment && audit ? workingLimit(audit.store, segment, groups.join(","),
    audit.purpose === "reading-planner" ? "planningChars" : "requestChars", initialRequestLimit!) : initialRequestLimit;
  const pack = (limit: number) => audit?.pilot && audit.purpose !== "reader" ? workingContext(audit.store, environment.projectId,
    audit.draftId, audit.questionId ?? "", context, limit - JSON.stringify({ ...envelope, subject: {} }).length) : context;
  let subject;
  try { subject = pack(requestLimit!); }
  catch (error) {
    if (!segment || !audit || !(error instanceof EngineError) || !["planning_context_limit", "pilot_core_limit", "synthesis_material_limit"].includes(error.code)) throw error;
    // Measure the exact packed representation locally; never pay to regenerate it.
    const required = (error.details as { required?: number } | null)?.required;
    requireCondition(Number.isSafeInteger(required) && required! > 0, "budget_need_unknown", "A working increase requires the actual minimal packed size");
    const needed = required! + JSON.stringify({ ...envelope, subject: {} }).length;
    requestLimit = accommodateMetric(audit.store, segment, groups.join(","), audit.purpose === "reading-planner" ? "planningChars" : "requestChars",
      initialRequestLimit!, needed, draft!, audit.questionId!, [reference(draft!)], error.message, audit.pilot?.value.physicalLimits?.maxRequestChars);
    subject = pack(requestLimit);
  }
  audit?.onContext?.(subject as Record<string, any>);
  const input = JSON.stringify({ ...envelope, subject });
  requireCondition(!audit?.pilot?.value.physicalLimits || input.length <= audit.pilot.value.physicalLimits.maxRequestChars,
    "budget_transport_limit", "The full envelope exceeds the declared physical transport capacity; split the material before dispatch");
  const replay = audit?.pilot ? replayLimitedResponse(audit.store, audit.pilot, role, audit.draftId,
    audit.questionId, audit.purpose, input) : null;
  if (replay) return replay.research;
  if (audit?.purpose === "reading-planner" && audit.pilot?.value.planning) {
    const rounds = audit.store.list<ModelCall>("model-call").filter(call => call.value.draftId === audit.draftId
      && call.value.questionId === audit.questionId && call.value.purpose === "reading-planner").length;
    const allowed = segment ? accommodateMetric(audit.store, segment, groups.join(","), "rounds", audit.pilot.value.planning.maxRounds,
      rounds + 1, draft!, audit.questionId!, [], "Addressed unresolved research requires another planning round") : audit.pilot.value.planning.maxRounds;
    requireCondition(rounds < allowed, "planning_round_limit", "Reading expansion allowance reached; evidence is preserved");
  }
  const reservation = !segment && audit?.pilot ? pilotDispatch(audit.store, audit.pilot, `model-call:${requestId}`, input.length) : { writes: [], guards: [] };
  const estimate = segment && audit ? estimateCliCall(audit.store, environment.projectId, role, audit.purpose, input.length) : null;
  if (segment && audit && estimate) {
    requireCondition(input.length <= requestLimit!, "pilot_request_limit", "Complete envelope exceeds its working limit");
    const remainingRoles = audit.purpose === "assessor" ? [] : audit.purpose === "analyst" ? [{ role: environment.reviewer, purpose: "assessor" }]
      : [{ role: environment.implementer, purpose: "analyst" }, { role: environment.reviewer, purpose: "assessor" },
        ...(audit.purpose === "reading-planner" ? [{ role: audit.pilot!.value.reader, purpose: "reader" }] : [])];
    const remaining = remainingRoles.reduce((total, item) => total + estimateCliCall(audit.store, environment.projectId, item.role, item.purpose, input.length).tokens, 0);
    accommodateQuestion(audit.store, segment, groups, estimate, draft!, audit.questionId!, remaining);
    const reserved = reserveResearchCall(audit.store, segment, `model-call:${requestId}`, groups, estimate);
    reservation.writes.push(...reserved.writes);
    reservation.guards.push(...reserved.guards, reference(policy!), reference(audit.pilot!), reference(draft!), reference(protectedQuestion!), ...draft!.value.inputs);
  }
  let call: Revision<ModelCall> | null = audit ? audit.store.writeMany<ModelCall>([{ id: `model-call:${requestId}`, kind: "model-call", expected: 0,
    value: { projectId: environment.projectId, draftId: audit.draftId, purpose: audit.purpose, requestId,
      ...(segment && estimate ? { budget: { segment: reference(segment), groups, estimate } } : {}),
      profile: audit.pilot ? reference(audit.pilot) : null,
      questionId: audit.questionId ?? null,
      startedAt: Date.now(), finishedAt: null, status: "running", requested: role,
      confirmed: { model: null, effort: null, speed: null }, request: { chars: input.length, bytes: Buffer.byteLength(input), hash: digest(input) },
      response: null, usage: null, usageSource: "unavailable", error: null } }, ...reservation.writes], reservation.guards)[0]! : null;
  let patch: Partial<ModelCall> = {};
  let rawResponse: string | null = null;
  try {
    const result = await runProcess(role.command, environment.workspace, input, environment.timeoutMs, signal);
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
    const replyLimit = segment && audit?.pilot ? accommodateMetric(audit.store, segment, groups.join(","), "replyChars", audit.pilot.value.maxReplyChars,
      JSON.stringify(response.research).length, draft!, audit.questionId!, [reference(draft!)], "Preserve an already paid complete response without regeneration", audit.pilot.value.physicalLimits?.maxReplyChars) : audit?.pilot?.value.maxReplyChars;
    requireCondition(!audit?.pilot?.value.physicalLimits || JSON.stringify(response.research).length <= audit.pilot.value.physicalLimits.maxReplyChars,
      "budget_transport_limit", "Response exceeds the declared physical response capacity");
    requireCondition(!audit?.pilot || JSON.stringify(response.research).length <= replyLimit!,
      "pilot_reply_limit", "The generated response exceeds the configured limit; its usage has been recorded");
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
        value: { ...call.value, ...patch, finishedAt: Date.now() } }, ...responseWrites])[0]!;
      if (segment && budgetUsage(audit.store, segment).measured > segment.value.limit) {
        audit.store.write({ id: `budget-incident:${requestId}`, kind: "budget-incident", expected: 0,
          value: { projectId: environment.projectId, segment: reference(segment), call: reference(call), reason: "Actual provider usage exceeded the experimental forecast and the owner budget; further calls are forbidden" } });
        throw new EngineError("budget_actual_overrun", "Actual usage exceeded the owner budget; the incident is recorded and further calls are blocked");
      }
    }
  }
}
