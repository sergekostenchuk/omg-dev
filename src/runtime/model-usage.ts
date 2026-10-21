import type { Store, Revision } from "../storage/store.js";
import type { RoleBinding } from "./environment.js";
import { requireCondition } from "../errors.js";
import type { Ref } from "../pipeline/contracts.js";
import type { Json } from "../canonical.js";
import type { ProcessResult } from "./process.js";
import type { runtimeExecutableIdentity } from "./runtime-observation.js";
import { budgetUsage, workingLimit, type BudgetSegment } from './research-budget.js';
import { readModelCallRecovery } from '../discovery/model-call-recovery.js';
import { reference } from '../pipeline/contracts.js';

/* LG62: the historical call-runtime telemetry forms, kept unchanged for their
 * readers (LG84) after their producer runtime/call-runtime.ts was removed. */
interface RuntimeFile { requested: string; kind: 'file' | 'executable'; path: string; hash: string; identity: ReturnType<typeof runtimeExecutableIdentity> }
interface CallRuntimeProbe { executable: string; args: ['--version']; result: ProcessResult }
interface CallRuntimeSnapshotBase {
  root: string; binding: Json; roleHash: string; invocation: RoleBinding['command'];
  interpreter: RuntimeFile; adapter: RuntimeFile; subjects: RuntimeFile[];
}
/** Version 1 is exactly the historical Codex era: the probe lives in `codex`. */
export interface CallRuntimeSnapshotV1 extends CallRuntimeSnapshotBase { codex: CallRuntimeProbe }
/** Version 2 names its provider explicitly instead of reusing the Codex field. */
export interface CallRuntimeSnapshotV2 extends CallRuntimeSnapshotBase { provider: CallRuntimeProbe & { protocol: string } }
export type CallRuntimeSnapshot = CallRuntimeSnapshotV1 | CallRuntimeSnapshotV2;
interface CallRuntimeEvidenceBase {
  declaration: Ref; requestHash: string;
  status: 'captured' | 'observed' | 'unavailable' | 'stale';
  startedAt: number; finishedAt: number | null; error: string | null;
}
export interface CallRuntimeEvidenceV1 extends CallRuntimeEvidenceBase { version: 1; snapshot: CallRuntimeSnapshotV1 | null }
export interface CallRuntimeEvidenceV2 extends CallRuntimeEvidenceBase { version: 2; snapshot: CallRuntimeSnapshotV2 | null }
export type CallRuntimeEvidence = CallRuntimeEvidenceV1 | CallRuntimeEvidenceV2;

export interface TokenUsage {
  inputTokens: number; outputTokens: number;
  cachedInputTokens: number | null; reasoningOutputTokens: number | null;
}
export interface ProcessIdentity { pid: number; started: string }
/** In this era the adapter must wait for its stdin request before any model
 * interaction. `authorized` is committed before runProcess transfers stdin. */
export interface ModelExecution {
  version: 'model-execution/v1';
  phase: 'claimed' | 'authorized';
  owner: ProcessIdentity;
  provider: (ProcessIdentity & { group: number | null }) | null;
}
export interface ModelCall {
  execution?: ModelExecution;
  recovery?: Ref;
  runtime?: CallRuntimeEvidence;
  projectId: string; draftId: string; purpose: string; requestId: string;
  profile?: Ref | null;
  progressKey?: string;
  ownerProcess?: {pid:number;started:string};
  providerProcess?: {pid:number;started:string};
  packet?: { archive: Ref; kind: string; maxChars: number };
  budget?: { segment: Ref; groups: string[]; estimate: import("./research-budget.js").CallEstimate };
  questionId?: string | null;
  /** Exact accepted plan edition for a v7 plan-question call. */
  planAnswer?: Ref;
  /** DR4: structural carrier; the saved intent, not this field alone, proves the producer. */
  variantSubject?: import('../discovery/discovery-variants.js').VariantSubject;
  /** The producer of the call: its consumer intent (analyst/planner/escalation) or its assessment application. */
  consumerIntent?: Ref; assessmentApplication?: Ref;
  startedAt: number; finishedAt: number | null; status: "running" | "succeeded" | "failed";
  requested: RoleBinding; confirmed: { model: string | null; effort: string | null; speed: string | null };
  request: { chars: number; bytes: number; hash: string; record?: Ref };
  response: { chars: number; bytes: number; record?: Ref } | null;
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
    budgets:store.list<BudgetSegment>('research-budget').filter(segment=>segment.value.projectId===project).map(segment=>{
      const usage=budgetUsage(store,segment),assignments=usage.ledger?.value.assignments??[];
      const details=(selected:typeof assignments)=>({calls:selected.length,
        unmeasuredCalls:selected.filter(item=>!calls.find(call=>call.id===item.call)?.value.usage).length});
      return {segment:{id:segment.id,revision:segment.revision,hash:segment.hash},key:segment.value.key,limit:segment.value.limit,
        measured:usage.measured,reserved:usage.reserved,remaining:usage.remaining,...details(assignments),
        groups:Object.entries(usage.groups).map(([group,row])=>{
          const limit=workingLimit(store,segment,group,'tokens',segment.value.initialGroupLimit);
          return {group,limit,...row,remaining:limit-row.measured-row.reserved,
            ...details(assignments.filter(item=>item.groups.includes(group)))};
        })};
    }),
    roles: keys.map(key => {
      const [purpose, model, effort, speed] = JSON.parse(key) as string[];
      const selected = calls.filter(record => record.value.purpose === purpose && record.value.requested.model === model
        && record.value.requested.effort === effort && (record.value.requested.speed ?? "inherited") === speed);
      return { purpose, model, effort, requestedSpeed: speed,
        confirmedSpeeds: [...new Set(selected.map(record => record.value.confirmed.speed))],
        cumulative: summarize(selected), period: summarize(selected.filter(record => recent.includes(record))) };
    }),
    interruptions: calls.filter(record => record.value.error === 'process_lost').map(record => {
      const proof = record.value.recovery ? readModelCallRecovery(store, project, reference(record)).proof : null;
      return { id: record.id, recovery: record.value.recovery ?? null, usageKnown: record.value.usage !== null,
        request: proof?.request ?? 'unknown', physical: proof?.physical ?? 'unknown' };
    }),
    active: calls.filter(record => record.value.status === "running").map(record => ({ id: record.id,
      draftId: record.value.draftId, questionId: record.value.questionId ?? null, purpose: record.value.purpose, model: record.value.requested.model,
      effort: record.value.requested.effort, speed: record.value.requested.speed ?? "inherited", startedAt: record.value.startedAt })) };
}
