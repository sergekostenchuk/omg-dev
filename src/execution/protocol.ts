import { randomUUID } from "node:crypto";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import { executeProcess, type ProcessObserver } from "./process.js";
import type { CompiledTask } from "../compiler/model.js";
import { requireCondition, EngineError } from "../errors.js";
import type { ArtifactValue, ReviewResult } from "./model.js";
import type { AgentUsage } from "./model.js";
import { boundedContext } from "../compiler/context.js";

export async function callAgent(role: RoleBinding, environment: Environment, mode: "implement" | "review",
  prompt: string, subject: unknown, maxChars: number, usage: (value: AgentUsage) => void, observer: ProcessObserver, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const request = boundedContext({ protocol: "omg-agent/v1", requestId, mode, model: role.model, effort: role.effort,
    ...(role.speed ? { speed: role.speed } : {}), prompt, subject }, maxChars);
  const measured: AgentUsage = { mode, model: role.model, effort: role.effort, requestHash: request.hash, requestChars: request.chars,
    requestBytes: request.utf8Bytes, responseChars: null, responseBytes: null };
  usage(measured);
  const result = await executeProcess(role.command, environment.workspace, request.text, environment.timeoutMs, observer, signal);
  usage({ ...measured, responseChars: result.stdout.length, responseBytes: Buffer.byteLength(result.stdout) });
  requireCondition(result.exitCode === 0, "executor_failed", result.stderr.slice(-2000) || "Selected executor failed");
  let response: Record<string, unknown>;
  try { response = JSON.parse(result.stdout); } catch { throw new EngineError("executor_protocol_invalid", "Executor must return one protocol response"); }
  requireCondition(response && response['protocol'] === "omg-agent/v1" && response['requestId'] === requestId,
    "executor_response_foreign", "Executor response does not belong to this invocation");
  return response;
}
export function implementation(response: Record<string, unknown>, task: CompiledTask): { text: string; artifacts: ArtifactValue[] } {
  const text = response['text']; const artifacts = response['artifacts'];
  requireCondition(typeof text === "string" && text.trim() && Array.isArray(artifacts), "implementation_missing", "Executor must return its result and output artifacts");
  requireCondition(artifacts.length === task.produces.length && artifacts.every(item => item && typeof item.id === "string")
    && new Set(artifacts.map(item => item.id)).size === artifacts.length
    && task.produces.every(id => artifacts.some(item => item.id === id)), "artifact_set_invalid", "All and only the task's output artifacts are required");
  requireCondition(artifacts.every(item => Object.keys(item).join(",") === "id"), "implementation_value_unexpected", "The agent identifies implemented contracts; the engine records code evidence rather than business values");
  return { text, artifacts };
}
export function review(response: Record<string, unknown>): ReviewResult {
  const result = response['review'] as ReviewResult | undefined;
  requireCondition(result && ["pass", "request_changes"].includes(result.verdict) && ["none", "code", "plan"].includes(result.kind)
    && Array.isArray(result.findings) && result.findings.every(item => typeof item === "string")
    && (result.verdict === "pass" ? result.kind === "none" && result.findings.length === 0 : result.kind !== "none" && result.findings.length > 0),
    "review_invalid", "Independent review requires a consistent verdict, correction route and findings");
  return result;
}
