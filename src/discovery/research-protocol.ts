import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";
import { runProcess } from "../runtime/process.js";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import { EngineError, requireCondition } from "../errors.js";
import type { ResearchAction } from "./research-model.js";
import type { Store, Revision } from "../storage/store.js";
import { tokenUsage, type ModelCall } from "../runtime/model-usage.js";
import { digest } from "../canonical.js";

const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const text = { type: "string", minLength: 1 };
const ref = object({ id: text, revision: { type: "integer", minimum: 1 }, hash: { type: "string", pattern: "^[a-f0-9]{64}$" } });
const selector = { oneOf: [object({ kind: { const: "json-pointer" }, pointer: { type: "string" } }),
  object({ kind: { const: "text-range" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } })] };
const validate = new Ajv({ allErrors: true }).compile<ResearchAction>({ oneOf: [
  object({ action: { const: "search" }, query: text }),
  object({ action: { const: "read_source" }, source: ref, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } }),
  object({ action: { const: "read" }, path: text, media: { enum: ["text/plain", "application/json"] } }),
  object({ action: { const: "answer" }, question: text, value: {}, citations: { type: "array", minItems: 1, items: object({ source: ref, selector }) } }),
  object({ action: { const: "need_owner" }, question: text, reason: text, searched: { type: "array", minItems: 1, items: ref } }),
  object({ action: { const: "pause" }, reason: text }),
] });
export function researchAction(value: unknown): ResearchAction {
  if (!validate(value)) throw new EngineError("research_response_invalid", "Research action has missing or invalid fields", validate.errors);
  return value;
}
export async function researchCall(role: RoleBinding, environment: Environment, prompt: string, context: unknown, signal?: AbortSignal,
  audit?: { store: Store; draftId: string; purpose: string }): Promise<unknown> {
  const requestId = randomUUID();
  const input = JSON.stringify({ protocol: "omg-agent/v1", requestId, mode: "research", model: role.model,
    effort: role.effort, ...(role.speed ? { speed: role.speed } : {}), prompt, subject: context });
  let call: Revision<ModelCall> | null = audit ? audit.store.write<ModelCall>({ id: `model-call:${requestId}`, kind: "model-call", expected: 0,
    value: { projectId: environment.projectId, draftId: audit.draftId, purpose: audit.purpose, requestId,
      startedAt: Date.now(), finishedAt: null, status: "running", requested: role,
      confirmed: { model: null, effort: null, speed: null }, request: { chars: input.length, bytes: Buffer.byteLength(input), hash: digest(input) },
      response: null, usage: null, usageSource: "unavailable", error: null } }) : null;
  let patch: Partial<ModelCall> = {};
  try {
    const result = await runProcess(role.command, environment.workspace, input, environment.timeoutMs, signal);
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
    patch.status = "succeeded"; return response.research;
  } catch (error) {
    patch.status = "failed"; patch.error = error instanceof EngineError ? error.code : "research_call_failed"; throw error;
  } finally {
    if (call && audit) call = audit.store.write<ModelCall>({ id: call.id, kind: call.kind, expected: call.revision,
      value: { ...call.value, ...patch, finishedAt: Date.now() } });
  }
}
