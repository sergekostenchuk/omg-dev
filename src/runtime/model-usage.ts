import type { Store, Revision } from "../storage/store.js";
import type { RoleBinding } from "./environment.js";
import { requireCondition } from "../errors.js";

export interface TokenUsage {
  inputTokens: number; outputTokens: number;
  cachedInputTokens: number | null; reasoningOutputTokens: number | null;
}
export interface ModelCall {
  projectId: string; draftId: string; purpose: string; requestId: string;
  startedAt: number; finishedAt: number | null; status: "running" | "succeeded" | "failed";
  requested: RoleBinding; confirmed: { model: string | null; effort: string | null; speed: string | null };
  request: { chars: number; bytes: number; hash: string };
  response: { chars: number; bytes: number } | null;
  usage: TokenUsage | null; usageSource: "adapter" | "unavailable"; error: string | null;
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function tokenUsage(value: unknown): TokenUsage | null {
  if (value === undefined || value === null) return null;
  const usage = value as TokenUsage;
  requireCondition(typeof value === "object" && Object.keys(value).sort().join(",") === "cachedInputTokens,inputTokens,outputTokens,reasoningOutputTokens"
    && count(usage.inputTokens) && count(usage.outputTokens)
    && (usage.cachedInputTokens === null || (count(usage.cachedInputTokens) && usage.cachedInputTokens <= usage.inputTokens))
    && (usage.reasoningOutputTokens === null || (count(usage.reasoningOutputTokens) && usage.reasoningOutputTokens <= usage.outputTokens)),
  "usage_invalid", "Token counts must be explicit nonnegative integers; cached/reasoning are subsets, unknown values are null");
  return usage;
}

export function modelUsage(store: Store, project: string, since: number) {
  requireCondition(Number.isSafeInteger(since) && since >= 0, "usage_window_invalid", "Use a Unix millisecond timestamp");
  const calls = store.list<ModelCall>("model-call").filter(record => record.value.projectId === project);
  const summarize = (records: Revision<ModelCall>[]) => {
    const known = records.flatMap(record => record.value.usage ? [record.value.usage] : []);
    return { attempts: records.length, succeeded: records.filter(record => record.value.status === "succeeded").length,
      failed: records.filter(record => record.value.status === "failed").length,
      running: records.filter(record => record.value.status === "running").length,
      measuredCalls: known.length, unmeasuredCalls: records.length - known.length,
      requestChars: records.reduce((sum, record) => sum + record.value.request.chars, 0),
      responseChars: records.reduce((sum, record) => sum + (record.value.response?.chars ?? 0), 0),
      reportedTokens: known.length ? { input: known.reduce((sum, usage) => sum + usage.inputTokens, 0),
        output: known.reduce((sum, usage) => sum + usage.outputTokens, 0),
        cachedInput: known.every(usage => usage.cachedInputTokens !== null) ? known.reduce((sum, usage) => sum + usage.cachedInputTokens!, 0) : null,
        reasoningOutput: known.every(usage => usage.reasoningOutputTokens !== null) ? known.reduce((sum, usage) => sum + usage.reasoningOutputTokens!, 0) : null } : null };
  };
  const recent = calls.filter(record => (record.value.finishedAt ?? record.value.startedAt) >= since);
  const keys = [...new Set(calls.map(record => JSON.stringify([record.value.purpose, record.value.requested.model,
    record.value.requested.effort, record.value.requested.speed ?? "inherited"])))];
  return { project, since, cumulative: summarize(calls), period: summarize(recent),
    roles: keys.map(key => {
      const [purpose, model, effort, speed] = JSON.parse(key) as string[];
      const selected = calls.filter(record => record.value.purpose === purpose && record.value.requested.model === model
        && record.value.requested.effort === effort && (record.value.requested.speed ?? "inherited") === speed);
      return { purpose, model, effort, requestedSpeed: speed,
        confirmedSpeeds: [...new Set(selected.map(record => record.value.confirmed.speed))],
        cumulative: summarize(selected), period: summarize(selected.filter(record => recent.includes(record))) };
    }),
    active: calls.filter(record => record.value.status === "running").map(record => ({ id: record.id,
      draftId: record.value.draftId, purpose: record.value.purpose, model: record.value.requested.model,
      effort: record.value.requested.effort, speed: record.value.requested.speed ?? "inherited", startedAt: record.value.startedAt })) };
}
