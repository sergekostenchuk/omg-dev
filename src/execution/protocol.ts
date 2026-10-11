import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store, Revision, Write } from "../storage/store.js";
import type { Ref } from "../pipeline/contracts.js";
import { tokenUsage, type TokenUsage } from "../runtime/model-usage.js";
import type { Environment, RoleBinding } from "../runtime/environment.js";
import { executeProcess, type ProcessObserver } from "./process.js";
import type { CompiledTask } from "../compiler/model.js";
import { requireCondition, EngineError } from "../errors.js";
import type { ArtifactValue, ReviewResult } from "./model.js";
import type { AgentUsage } from "./model.js";
import { boundedContext } from "../compiler/context.js";

// ---- EX1 B: one durable record per launch of a role (№3945, №3953). ----

export const EXECUTION_SEND_KIND = "execution-send";
export const EXECUTION_SEND_CONTRACT = "execution-send/v1";
export const EXECUTION_GATE_REFUSAL_CONTRACT = "execution-gate-refusal/v1";
export type ExecutionSendStatus = "sent" | "answered" | "failed" | "interrupted" | "lost" | "refused" | "not-started";
/** The process group the launch runs in: its supervisor is the group leader; the adapter and its provider are members. */
export interface ExecutionSendGroup { pid: number; started: string }
export interface ExecutionSend {
  contract: typeof EXECUTION_SEND_CONTRACT; project: string; plan: Ref; task: string; attempt: number;
  role: "implement" | "review"; ordinal: number; correction: boolean; admission: Ref | null;
  request: { hash: string; chars: number }; group: ExecutionSendGroup | null;
  status: ExecutionSendStatus; usage: TokenUsage | null; startedAt: number; finishedAt: number | null;
  /** EX2: the failed check a correction was shown (its index in the corrected attempt's checks, the excerpt's size, a cut), or
   * none. Every launch of this era names it; a launch of the earlier era has no such key. */
  feedback?: ExecutionSendFeedback | null;
}
export interface ExecutionSendFeedback { check: number; chars: number; truncated: boolean; basis: Ref }
export interface ExecutionSendSubject {
  project: string; plan: Ref; task: string; attempt: number; role: "implement" | "review"; ordinal: number; correction: boolean; admission: Ref | null;
  feedback: ExecutionSendFeedback | null;
}
export const executionSendPrefix = (project: string, planHash: string): string => `${EXECUTION_SEND_KIND}:${project}:${planHash}:`;
export const executionSendId = (subject: ExecutionSendSubject, planHash: string): string =>
  `${executionSendPrefix(subject.project, planHash)}${subject.task.replace(/^task:/, "")}:${subject.attempt}:${subject.role}:${subject.ordinal}`;
/** Statuses that never reached a provider: a proved gate refusal and a launch that never started cost nothing. */
export const UNSENT: readonly ExecutionSendStatus[] = ["refused", "not-started"];
const CLOSED: readonly ExecutionSendStatus[] = ["answered", "failed", "interrupted", "lost", "refused", "not-started"];

/**
 * The producer's derivation of a send record (№3590: checked when written, never re-derived by a budget reader). The open
 * value follows only from its subject and request; a closure only moves `sent` to one final status, once.
 */
export function sendValue(subject: ExecutionSendSubject, request: { hash: string; chars: number }, startedAt: number): ExecutionSend {
  requireCondition(Number.isSafeInteger(subject.attempt) && subject.attempt > 0 && Number.isSafeInteger(subject.ordinal) && subject.ordinal > 0
    && ["implement", "review"].includes(subject.role) && typeof subject.task === "string" && subject.task.length > 0
    && typeof request.hash === "string" && Number.isSafeInteger(request.chars) && request.chars > 0
    && (subject.feedback === null || (subject.correction && Number.isSafeInteger(subject.feedback.check) && subject.feedback.check >= 0
      && Number.isSafeInteger(subject.feedback.chars) && subject.feedback.chars > 0 && typeof subject.feedback.truncated === "boolean"
      && typeof subject.feedback.basis?.id === "string" && Number.isSafeInteger(subject.feedback.basis.revision) && typeof subject.feedback.basis.hash === "string")),
  "execution_send_invalid", "A send names its exact plan task, attempt, role, ordinal and request");
  return { contract: EXECUTION_SEND_CONTRACT, project: subject.project, plan: { ...subject.plan }, task: subject.task, attempt: subject.attempt,
    role: subject.role, ordinal: subject.ordinal, correction: subject.correction, admission: subject.admission ? { ...subject.admission } : null,
    request: { hash: request.hash, chars: request.chars }, group: null, status: "sent", usage: null, startedAt, finishedAt: null,
    feedback: subject.feedback ? { ...subject.feedback, basis: { ...subject.feedback.basis } } : null };
}
/**
 * The gate's own saved refusal of exactly this send: written by the gate before it exits, beside the store, so it survives
 * the kill of the group (№3953-4). A refusal without this record proves nothing.
 */
export function gateRefusalPath(store: Store, id: string): string {
  return join(dirname(store.path), "execution-gate", `${encodeURIComponent(id)}.json`);
}
export function gateRefused(store: Store, id: string): boolean {
  const path = gateRefusalPath(store, id);
  if (!existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return value["contract"] === EXECUTION_GATE_REFUSAL_CONTRACT && value["send"] === id && typeof value["reason"] === "string";
  } catch { return false; }
}

/**
 * One launch of a role. The open record is written before the adapter's process starts; the group leader is added when the
 * supervisor is observed; the closure is prepared, not written: its caller writes it in the same transaction as the
 * outcome it applies to the task run (№3953-3), so an answered launch and its application never part.
 */
export class ExecutionSendHandle {
  #record: Revision<ExecutionSend>;
  #closure: Write | null = null;
  #observed = false;
  constructor(readonly store: Store, subject: ExecutionSendSubject, planHash: string, request: { hash: string; chars: number }) {
    const value = sendValue(subject, request, Date.now());
    this.#record = store.write<ExecutionSend>({ id: executionSendId(subject, planHash), kind: EXECUTION_SEND_KIND, expected: 0, value: value as never });
  }
  get id(): string { return this.#record.id; }
  get record(): Revision<ExecutionSend> { return this.#record; }
  group(child: ExecutionSendGroup | null): void {
    if (!child || this.#observed) return;
    this.#observed = true;
    this.#record = this.store.write<ExecutionSend>({ id: this.#record.id, kind: EXECUTION_SEND_KIND, expected: this.#record.revision,
      value: { ...this.#record.value, group: { pid: child.pid, started: child.started } } as never });
  }
  get observed(): boolean { return this.#observed; }
  close(status: ExecutionSendStatus, usage: TokenUsage | null): void {
    requireCondition(CLOSED.includes(status) && this.#record.value.status === "sent" && this.#closure === null,
      "execution_send_invalid", "A send is closed once, from sent");
    this.#closure = { id: this.#record.id, kind: EXECUTION_SEND_KIND, expected: this.#record.revision,
      value: { ...this.#record.value, status, usage: UNSENT.includes(status) ? null : usage, finishedAt: Date.now() } as never };
  }
  /** The prepared closure, handed to the one transaction that applies its outcome; taken once. */
  take(): Write | null { const closure = this.#closure; this.#closure = null; return closure; }
}
/** Closes an open send left by a lost process: the gate's saved refusal, a launch never observed, or an unknown outcome. */
export function lostSendClosure(store: Store, send: Revision<ExecutionSend>): Write {
  const status: ExecutionSendStatus = gateRefused(store, send.id) ? "refused" : send.value.group === null ? "not-started" : "lost";
  return { id: send.id, kind: EXECUTION_SEND_KIND, expected: send.revision, value: { ...send.value, status, usage: null, finishedAt: Date.now() } as never };
}
/** The usage the adapter reported in its one output object, also on failure; anything else is unknown, never zero. */
function reportedUsage(stdout: string, requestId: string): TokenUsage | null {
  try {
    const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return value && value["requestId"] === requestId ? tokenUsage(value["usage"]) : null;
  } catch { return null; }
}

export async function callAgent(role: RoleBinding, environment: Environment, mode: "implement" | "review",
  prompt: string, subject: unknown, maxChars: number, usage: (value: AgentUsage) => void, observer: ProcessObserver, signal?: AbortSignal,
  send?: (request: { hash: string; chars: number }) => ExecutionSendHandle): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const request = boundedContext({ protocol: "omg-agent/v1", requestId, mode, model: role.model, effort: role.effort,
    ...(role.speed ? { speed: role.speed } : {}), prompt, subject }, maxChars);
  if (signal?.aborted) throw new EngineError("process_cancelled", "The execution was stopped before this launch");
  const handle = send?.({ hash: request.hash, chars: request.chars });
  const measured: AgentUsage = { mode, model: role.model, effort: role.effort, requestHash: request.hash, requestChars: request.chars,
    requestBytes: request.utf8Bytes, responseChars: null, responseBytes: null };
  usage(measured);
  let result: Awaited<ReturnType<typeof executeProcess>>;
  try {
    result = await executeProcess(role.command, environment.workspace, request.text, environment.timeoutMs,
      child => { handle?.group(child); observer(child); }, signal);
  } catch (error) {
    // No output: a launch never observed did not start; after it started only the gate's own record proves no send.
    handle?.close(!handle.observed ? "not-started" : gateRefused(handle.store, handle.id) ? "refused" : "interrupted", null);
    throw error;
  }
  usage({ ...measured, responseChars: result.stdout.length, responseBytes: Buffer.byteLength(result.stdout) });
  const reported = reportedUsage(result.stdout, requestId);
  if (result.exitCode !== 0) {
    handle?.close(reported === null && gateRefused(handle.store, handle.id) ? "refused" : "failed", reported);
    throw new EngineError("executor_failed", result.stderr.slice(-2000) || "Selected executor failed");
  }
  handle?.close("answered", reported);
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
